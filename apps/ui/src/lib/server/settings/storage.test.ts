import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db';
import { StorageMeter, foldTables, storageFacts } from './storage';

/** The Settings page's database size (docs/settings-and-perf-plan.md §2.3, D15). */

const DAY = 86_400_000;
const dirs: string[] = [];
const dbs: Db[] = [];

function fileDb(): { db: Db; path: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), 'caddy-ui-storage-'));
	dirs.push(dir);
	const path = join(dir, 'caddy-ui.db');
	const db = openDb(path);
	dbs.push(db);
	return { db, path, dir };
}

function seedProbes(db: Db, n: number, from: number) {
	const put = db.prepare(
		`INSERT INTO probes (site_id, target, kind, ts, ok, latency_ms, status, error) VALUES (?, '', 'site', ?, 1, 12, 200, NULL)`
	);
	db.transaction(() => {
		for (let i = 0; i < n; i++) put.run(`s${i % 5}`, from + i * 30_000);
	})();
}

afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('storageFacts', () => {
	it('reports the file, the volume and the oldest pruned rows', () => {
		const { db, path, dir } = fileDb();
		const now = Date.now();
		seedProbes(db, 100, now - 3 * DAY);
		const f = storageFacts(db, path, dir, now);
		expect(f.fileBytes).toBeGreaterThan(0);
		expect(f.oldest.probes).toBe(now - 3 * DAY);
		expect(f.oldest.metric_samples).toBeNull();
		expect(f.volumeFreeBytes).toBeGreaterThan(0);
		expect(f.volumeTotalBytes).toBeGreaterThanOrEqual(f.volumeFreeBytes as number);
	});

	it('works on an in-memory database without a volume', () => {
		const db = openDb(':memory:');
		const f = storageFacts(db, ':memory:', '/does/not/exist');
		expect(f.fileBytes).toBeGreaterThan(0);
		expect(f.walBytes).toBe(0);
		expect(f.volumeFreeBytes).toBeNull();
		db.close();
	});
});

describe('foldTables', () => {
	it('adds indexes to their table and counts rows from the table only', () => {
		const tables = foldTables({
			ok: true,
			btrees: [
				{ name: 'probes', bytes: 4096 * 10, cells: 500 },
				{ name: 'probes_ts', bytes: 4096 * 3, cells: 499 },
				{ name: 'probe_latest', bytes: 4096, cells: 7 },
				{ name: 'sqlite_master', bytes: 4096, cells: 20 }
			],
			owners: [
				{ name: 'probes', tbl_name: 'probes', type: 'table' },
				{ name: 'probes_ts', tbl_name: 'probes', type: 'index' },
				{ name: 'probe_latest', tbl_name: 'probe_latest', type: 'table' }
			]
		});
		expect(tables[0]).toEqual({ name: 'probes', bytes: 4096 * 13, rows: 500 });
		expect(tables.find((t) => t.name === 'probe_latest')?.rows).toBe(7);
		expect(tables.find((t) => t.name === 'sqlite_schema')).toBeDefined();
	});
});

describe('StorageMeter', () => {
	it('measures every table in a worker, with exact row counts', async () => {
		const { db, path } = fileDb();
		seedProbes(db, 2_000, Date.now() - DAY);
		const meter = new StorageMeter(path);
		const m = await meter.measure();
		expect(m.error).toBeUndefined();
		const probes = m.tables.find((t) => t.name === 'probes');
		expect(probes?.rows).toBe(2_000);
		expect(probes?.bytes).toBeGreaterThan(0);
		expect(m.tables.find((t) => t.name === 'settings_log')).toBeDefined();
	});

	it('remembers a good answer for its lifetime and shares a running measurement', async () => {
		const { path } = fileDb();
		let t = 1_000_000;
		const meter = new StorageMeter(path, { now: () => t, maxAgeMs: 60_000 });
		const a = meter.measure();
		expect(meter.measure()).toBe(a);
		const first = await a;
		expect(meter.current()).toBe(first);
		t += 61_000;
		expect(meter.current()).toBeInstanceOf(Promise);
	});

	it('answers with an error, never a rejection, when the file is missing', async () => {
		const meter = new StorageMeter('/does/not/exist/caddy-ui.db');
		const m = await meter.measure();
		expect(m.error).toBeTruthy();
		expect(m.tables).toEqual([]);
	});
});
