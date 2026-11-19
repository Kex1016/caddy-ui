import { createReadStream, statfsSync, statSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { createGzip } from 'node:zlib';
import type { MaintenanceState, TaskState } from '$lib/settings/types';

/**
 * Storage tools for Settings → Data and storage (docs/settings-and-perf-plan.md §3): prune now, compact the
 * database, and a backup to download. Each one keeps the server answering requests while it runs:
 *
 * - Prune uses the collector's own batched prune, which pauses between batches (the hourly job, run now).
 * - Compact runs `VACUUM` in a worker thread on its own connection, with the collector's writing jobs held, so
 *   the main thread never waits on the lock. It needs about twice the database's size free on the volume.
 * - Backup runs `VACUUM INTO` in a worker thread on a read-only connection. In WAL mode that is a read, so
 *   probes keep being written meanwhile. The copy is streamed out as a .tar.gz with the Caddyfile, then deleted.
 */

const idle = (): TaskState => ({
	running: false,
	startedAt: null,
	finishedAt: null,
	result: null,
	error: null
});

/** What the maintenance jobs need from the rest of the server; tests pass fakes. */
export type MaintenanceDeps = {
	dbPath: string;
	dataDir: string;
	caddyfilePath: string;
	prune: () => Promise<{ probes: number; metrics: number }>;
	/** Pause the jobs that write to the database; resolves to the function that resumes them. */
	hold: () => Promise<() => void>;
	now?: () => number;
	/** Free bytes on the volume of `dataDir`; null when unknown. */
	freeBytes?: (dir: string) => number | null;
};

export class MaintenanceRefused extends Error {
	constructor(
		message: string,
		/** `busy`: another storage job runs; `space`: the volume has no room; `unsupported`: an in-memory database. */
		readonly code: 'busy' | 'space' | 'unsupported'
	) {
		super(message);
		this.name = 'MaintenanceRefused';
	}
}

const fileSize = (path: string): number => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

function volumeFree(dir: string): number | null {
	try {
		const s = statfsSync(dir);
		return s.bavail * s.bsize;
	} catch {
		return null;
	}
}

const fmt = (n: number) => n.toLocaleString('en-GB');

function mb(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

// Kept as source text so it needs no separate file in the build (as in storage.ts): CommonJS run with `eval`.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
let db;
try {
	if (workerData.op === 'compact') {
		db = new Database(workerData.path, { fileMustExist: true });
		db.pragma('busy_timeout = 30000');
		db.exec('VACUUM');
		db.pragma('wal_checkpoint(TRUNCATE)');
	} else {
		db = new Database(workerData.path, { readonly: true, fileMustExist: true });
		db.pragma('busy_timeout = 30000');
		db.prepare('VACUUM INTO ?').run(workerData.into);
	}
	parentPort.postMessage({ ok: true });
} catch (err) {
	parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
} finally {
	if (db) db.close();
}
`;

type WorkerJob = { op: 'compact'; path: string } | { op: 'copy'; path: string; into: string };

/** Run one job in a worker thread. Resolves with an error message, or null when it worked. Never rejects. */
function runWorker(job: WorkerJob, timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		let worker: Worker;
		try {
			const driver = createRequire(import.meta.url).resolve('better-sqlite3');
			worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { ...job, driver } });
		} catch (err) {
			resolve(err instanceof Error ? err.message : String(err));
			return;
		}
		let settled = false;
		const done = (v: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};
		const timer = setTimeout(() => {
			void worker.terminate();
			done(`It took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped`);
		}, timeoutMs);
		timer.unref?.();
		worker.once('message', (m: { ok: boolean; error?: string }) => done(m.ok ? null : (m.error ?? 'failed')));
		worker.once('error', (err) => done(err.message));
		worker.once('exit', (code) => done(code === 0 ? null : `The worker stopped (exit code ${code})`));
	});
}

export class Maintenance {
	readonly #deps: MaintenanceDeps;
	readonly #now: () => number;
	readonly #free: (dir: string) => number | null;
	#prune: TaskState = idle();
	#compact: TaskState = idle();
	#backups = 0;
	#runningPrune: Promise<void> | null = null;
	#runningCompact: Promise<void> | null = null;

	constructor(deps: MaintenanceDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#free = deps.freeBytes ?? volumeFree;
	}

	state(): MaintenanceState {
		return { prune: { ...this.#prune }, compact: { ...this.#compact }, backupRunning: this.#backups > 0 };
	}

	/** Start the retention prune now. Returns at once; `state()` says when it is done. */
	startPrune(): Promise<void> {
		if (this.#runningPrune) return this.#runningPrune;
		this.#prune = { ...idle(), running: true, startedAt: this.#now() };
		this.#runningPrune = (async () => {
			try {
				const r = await this.#deps.prune();
				this.#prune = {
					...this.#prune,
					result:
						r.probes + r.metrics === 0
							? 'Nothing was older than the retention window.'
							: `Deleted ${fmt(r.probes)} probe results and ${fmt(r.metrics)} metric samples.`
				};
			} catch (err) {
				this.#prune = { ...this.#prune, error: err instanceof Error ? err.message : String(err) };
			} finally {
				this.#prune = { ...this.#prune, running: false, finishedAt: this.#now() };
				this.#runningPrune = null;
			}
		})();
		return this.#runningPrune;
	}

	/**
	 * Start compacting the database. Refuses (throws `MaintenanceRefused`) when it is already running, a backup
	 * is being made, or the volume has less than twice the database's size free. Returns at once.
	 */
	startCompact(): Promise<void> {
		if (this.#runningCompact) return this.#runningCompact;
		if (this.#backups > 0)
			throw new MaintenanceRefused('A backup is being made. Compact when it is done.', 'busy');
		const { dbPath, dataDir } = this.#deps;
		if (dbPath === ':memory:')
			throw new MaintenanceRefused('An in-memory database cannot be compacted.', 'unsupported');
		const size = fileSize(dbPath) + fileSize(`${dbPath}-wal`);
		const free = this.#free(dataDir);
		if (free !== null && free < size * 2) {
			throw new MaintenanceRefused(
				`Compacting needs about twice the database's size free (${mb(size * 2)}); the volume has ${mb(free)}.`,
				'space'
			);
		}
		this.#compact = { ...idle(), running: true, startedAt: this.#now() };
		this.#runningCompact = (async () => {
			const release = await this.#deps.hold();
			try {
				const error = await runWorker({ op: 'compact', path: dbPath }, 60 * 60_000);
				const after = fileSize(dbPath) + fileSize(`${dbPath}-wal`);
				this.#compact = error
					? { ...this.#compact, error }
					: {
							...this.#compact,
							result:
								after < size
									? `The file went from ${mb(size)} to ${mb(after)}.`
									: `Done. The file is ${mb(after)}; there was no free space to give back.`
						};
			} finally {
				release();
				this.#compact = { ...this.#compact, running: false, finishedAt: this.#now() };
				this.#runningCompact = null;
			}
		})();
		return this.#runningCompact;
	}

	/**
	 * A backup as a .tar.gz stream: the database (a consistent copy made with `VACUUM INTO`, so it is also
	 * compact) and the Caddyfile. The copy is written next to the database first and deleted once streamed.
	 */
	async backup(): Promise<{ stream: ReadableStream<Uint8Array>; name: string }> {
		if (this.#runningCompact)
			throw new MaintenanceRefused('The database is being compacted. Try again when it is done.', 'busy');
		const { dbPath, dataDir, caddyfilePath } = this.#deps;
		if (dbPath === ':memory:')
			throw new MaintenanceRefused('An in-memory database cannot be backed up.', 'unsupported');
		const size = fileSize(dbPath) + fileSize(`${dbPath}-wal`);
		const free = this.#free(dataDir);
		if (free !== null && free < size) {
			throw new MaintenanceRefused(
				`A backup is copied next to the database first, which needs up to ${mb(size)} free; the volume has ${mb(free)}.`,
				'space'
			);
		}
		const at = this.#now();
		const stamp = new Date(at)
			.toISOString()
			.replace(/[-:]/g, '')
			.replace(/\.\d+Z$/, 'Z');
		const copy = join(dataDir, `.backup-${stamp}-${process.pid}.db`);
		this.#backups++;
		let handedOver = false;
		try {
			const error = await runWorker({ op: 'copy', path: dbPath, into: copy }, 60 * 60_000);
			if (error) throw new Error(`The database could not be copied: ${error}`);
			let caddyfile: Buffer | null = null;
			try {
				caddyfile = await readFile(caddyfilePath);
			} catch {
				// No Caddyfile to add; the archive still has the database.
			}
			const out = tarGz(
				[
					{ name: 'caddy-ui.db', size: fileSize(copy), mtime: at, body: () => createReadStream(copy) },
					...(caddyfile
						? [
								{
									name: 'Caddyfile',
									size: caddyfile.length,
									mtime: at,
									body: () => Readable.from([caddyfile])
								}
							]
						: [])
				],
				() => {
					try {
						unlinkSync(copy);
					} catch {
						// Already gone.
					}
					this.#backups--;
				}
			);
			handedOver = true;
			return {
				stream: Readable.toWeb(out) as ReadableStream<Uint8Array>,
				name: `caddy-ui-backup-${stamp}.tar.gz`
			};
		} finally {
			if (!handedOver) {
				try {
					unlinkSync(copy);
				} catch {
					// Never written.
				}
				this.#backups--;
			}
		}
	}
}

type TarEntry = { name: string; size: number; mtime: number; body: () => Readable };

/** One 512-byte ustar header for a regular file. */
export function tarHeader(name: string, size: number, mtimeMs: number): Buffer {
	const h = Buffer.alloc(512, 0);
	const put = (s: string, off: number, len: number) => h.write(s, off, len, 'ascii');
	const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
	put(name, 0, 100);
	put(oct(0o600, 8), 100, 8);
	put(oct(0, 8), 108, 8);
	put(oct(0, 8), 116, 8);
	put(oct(size, 12), 124, 12);
	put(oct(Math.floor(mtimeMs / 1000), 12), 136, 12);
	put('        ', 148, 8);
	put('0', 156, 1);
	put('ustar\0', 257, 6);
	put('00', 263, 2);
	let sum = 0;
	for (const b of h) sum += b;
	put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
	return h;
}

/** Stream files as a gzipped tar. `done` runs once when the stream ends, fails or is cancelled. */
export function tarGz(entries: TarEntry[], done: () => void): Readable {
	const tar = new PassThrough();
	const gz = createGzip();
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		done();
	};
	gz.once('end', finish);
	gz.once('close', finish);
	gz.once('error', finish);
	tar.pipe(gz);
	void (async () => {
		try {
			for (const e of entries) {
				tar.write(tarHeader(e.name, e.size, e.mtime));
				let written = 0;
				for await (const chunk of e.body()) {
					const buf = chunk as Buffer;
					written += buf.length;
					if (!tar.write(buf)) await new Promise((r) => tar.once('drain', r));
				}
				if (written !== e.size) throw new Error(`${e.name} changed size while it was archived`);
				const pad = (512 - (e.size % 512)) % 512;
				if (pad) tar.write(Buffer.alloc(pad, 0));
			}
			tar.end(Buffer.alloc(1024, 0));
		} catch (err) {
			gz.destroy(err instanceof Error ? err : new Error(String(err)));
			finish();
		}
	})();
	return gz;
}
