import { statfsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { StorageFacts, StorageMeasure, StorageTable } from '$lib/settings/types';
import type { Db } from '../db';

/**
 * Database size for the Settings page (docs/settings-and-perf-plan.md §2.3 and D15: the storage view ships with
 * S2 because raw probes are kept for the full retention, about 2.6 GB at 90 days).
 *
 * Two parts. `storageFacts` is what SQLite and the file system answer at once (file size, free space, the oldest
 * row of each pruned table) and runs in the page's `load`. `StorageMeter` gives the size and row count of every
 * table, which means reading every page of the database: it runs `dbstat` in a worker thread on a read-only
 * connection, so the server keeps answering requests meanwhile (cause 2 in §1.2), and remembers the answer.
 */

/** Tables the hourly prune trims to the retention window (collector/store.ts `PRUNED`, minus probe_latest). */
export const PRUNED_TABLES = ['probes', 'metric_samples'] as const;

const fileSize = (path: string): number => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

/** File size, free space on the volume and the oldest pruned rows. Indexed lookups only; well under 1 ms. */
export function storageFacts(db: Db, dbPath: string, dataDir: string, now = Date.now()): StorageFacts {
	const pageSize = db.pragma('page_size', { simple: true }) as number;
	const pages = db.pragma('page_count', { simple: true }) as number;
	const freePages = db.pragma('freelist_count', { simple: true }) as number;
	let free: number | null = null;
	let total: number | null = null;
	try {
		const s = statfsSync(dataDir);
		free = s.bavail * s.bsize;
		total = s.blocks * s.bsize;
	} catch {
		// Not a real directory (tests with :memory:), or the platform has no statfs.
	}
	const oldest: StorageFacts['oldest'] = {};
	for (const table of PRUNED_TABLES) {
		// Both tables have an index on ts, so MIN(ts) is one index lookup.
		const row = db.prepare(`SELECT MIN(ts) AS ts FROM ${table}`).get() as { ts: number | null };
		oldest[table] = row.ts;
	}
	return {
		at: now,
		fileBytes: dbPath === ':memory:' ? pages * pageSize : fileSize(dbPath),
		walBytes: dbPath === ':memory:' ? 0 : fileSize(`${dbPath}-wal`),
		freeInFileBytes: freePages * pageSize,
		volumeFreeBytes: free,
		volumeTotalBytes: total,
		oldest
	};
}

/** What the worker sends back: one row per b-tree (table or index), and which table each index belongs to. */
type WorkerAnswer =
	| {
			ok: true;
			btrees: { name: string; bytes: number; cells: number }[];
			owners: { name: string; tbl_name: string; type: string }[];
	  }
	| { ok: false; error: string };

// Kept as source text so it needs no separate file in the build: a worker started with `eval` runs it as CommonJS.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
let db;
try {
	db = new Database(workerData.path, { readonly: true, fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	const btrees = db.prepare(
		"SELECT name, SUM(pgsize) AS bytes, SUM(CASE WHEN pagetype = 'leaf' THEN ncell ELSE 0 END) AS cells FROM dbstat GROUP BY name"
	).all();
	const owners = db.prepare("SELECT name, tbl_name, type FROM sqlite_schema WHERE type IN ('table', 'index')").all();
	parentPort.postMessage({ ok: true, btrees, owners });
} catch (err) {
	parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
} finally {
	if (db) db.close();
}
`;

/** Fold b-trees into tables: a table's size includes its indexes; its row count is the table's own leaf cells. */
export function foldTables(answer: Extract<WorkerAnswer, { ok: true }>): StorageTable[] {
	const owner = new Map(answer.owners.map((o) => [o.name, o.tbl_name]));
	const tables = new Map<string, StorageTable>();
	for (const b of answer.btrees) {
		const name = b.name === 'sqlite_master' ? 'sqlite_schema' : b.name;
		const table = owner.get(name) ?? name;
		const t = tables.get(table) ?? { name: table, bytes: 0, rows: 0 };
		t.bytes += b.bytes;
		// A WITHOUT ROWID table is stored as an index b-tree under its own name, so its cells are its rows too.
		if (table === name) t.rows += b.cells;
		tables.set(table, t);
	}
	return [...tables.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

type MeterOpts = { now?: () => number; maxAgeMs?: number; timeoutMs?: number };

/** Measures table sizes off the main thread and remembers the answer for `maxAgeMs` (15 minutes by default). */
export class StorageMeter {
	readonly #path: string;
	readonly #now: () => number;
	readonly #maxAge: number;
	readonly #timeout: number;
	#last: StorageMeasure | null = null;
	#running: Promise<StorageMeasure> | null = null;

	constructor(path: string, opts: MeterOpts = {}) {
		this.#path = path;
		this.#now = opts.now ?? Date.now;
		this.#maxAge = opts.maxAgeMs ?? 15 * 60_000;
		this.#timeout = opts.timeoutMs ?? 120_000;
	}

	/** The last answer if it is fresh enough, else a measurement (shared if one is already running). */
	current(): StorageMeasure | Promise<StorageMeasure> {
		if (this.#last && this.#now() - this.#last.at < this.#maxAge) return this.#last;
		return this.measure();
	}

	/** Measure now, unless a measurement is already running. Never rejects: a failure is in `error`. */
	measure(): Promise<StorageMeasure> {
		this.#running ??= this.#run().finally(() => (this.#running = null));
		return this.#running;
	}

	async #run(): Promise<StorageMeasure> {
		const started = this.#now();
		if (this.#path === ':memory:') {
			return { at: started, tookMs: 0, tables: [], error: 'An in-memory database cannot be measured' };
		}
		const answer = await this.#ask();
		const result: StorageMeasure = answer.ok
			? { at: this.#now(), tookMs: this.#now() - started, tables: foldTables(answer) }
			: { at: this.#now(), tookMs: this.#now() - started, tables: [], error: answer.error };
		// Keep a good answer over a failed one; a failure is not remembered, so the next visit tries again.
		if (answer.ok) this.#last = result;
		return result;
	}

	#ask(): Promise<WorkerAnswer> {
		return new Promise((resolve) => {
			let worker: Worker;
			try {
				const driver = createRequire(import.meta.url).resolve('better-sqlite3');
				worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { path: this.#path, driver } });
			} catch (err) {
				resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
				return;
			}
			const timer = setTimeout(() => {
				void worker.terminate();
				resolve({ ok: false, error: `Measuring took longer than ${this.#timeout / 1000}s and was stopped` });
			}, this.#timeout);
			timer.unref?.();
			worker.once('message', (m: WorkerAnswer) => {
				clearTimeout(timer);
				resolve(m);
			});
			worker.once('error', (err) => {
				clearTimeout(timer);
				resolve({ ok: false, error: err.message });
			});
			worker.once('exit', (code) => {
				clearTimeout(timer);
				resolve({ ok: false, error: `The measuring worker stopped (exit code ${code})` });
			});
		});
	}
}
