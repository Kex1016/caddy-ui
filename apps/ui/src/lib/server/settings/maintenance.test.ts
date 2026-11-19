import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { Maintenance, MaintenanceRefused, tarHeader } from './maintenance';

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'caddy-ui-maint-'));
	const dbPath = join(dir, 'caddy-ui.db');
	const db = openDb(dbPath);
	const ins = db.prepare(
		`INSERT INTO probes (site_id, target, kind, ts, ok, latency_ms, status, error) VALUES ('s', 't', 'site', ?, 1, 1, 200, NULL)`
	);
	db.transaction(() => {
		for (let i = 0; i < 20_000; i++) ins.run(i);
	})();
	// Leave free pages behind, which compacting gives back.
	db.prepare(`DELETE FROM probes WHERE ts < 15000`).run();
	db.pragma('wal_checkpoint(TRUNCATE)');
	writeFileSync(join(dir, 'Caddyfile'), 'a.example.com {\n\trespond 200\n}\n');
	let held = 0;
	let released = 0;
	const m = new Maintenance({
		dbPath,
		dataDir: dir,
		caddyfilePath: join(dir, 'Caddyfile'),
		prune: async () => ({ probes: 3, metrics: 4 }),
		hold: async () => {
			held++;
			return () => released++;
		}
	});
	return { dir, dbPath, db, m, counts: () => ({ held, released }) };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const c of Readable.fromWeb(stream as never)) parts.push(c as Buffer);
	return Buffer.concat(parts);
}

describe('Maintenance', () => {
	it('prunes in the background and says what it deleted', async () => {
		const { m } = setup();
		const run = m.startPrune();
		expect(m.state().prune.running).toBe(true);
		await run;
		expect(m.state().prune).toMatchObject({ running: false, error: null });
		expect(m.state().prune.result).toBe('Deleted 3 probe results and 4 metric samples.');
	});

	it('compacts in a worker with the collector held, and the file shrinks', async () => {
		const { m, dbPath, db, counts } = setup();
		const before = readFileSync(dbPath).length;
		await m.startCompact();
		expect(counts()).toEqual({ held: 1, released: 1 });
		expect(m.state().compact.error).toBeNull();
		expect(m.state().compact.result).toMatch(/went from/);
		expect(readFileSync(dbPath).length).toBeLessThan(before);
		// The main connection still works afterwards.
		expect((db.prepare('SELECT COUNT(*) AS n FROM probes').get() as { n: number }).n).toBe(5_000);
	});

	it('refuses to compact without twice the size free', () => {
		const { dir, dbPath } = setup();
		const m = new Maintenance({
			dbPath,
			dataDir: dir,
			caddyfilePath: join(dir, 'Caddyfile'),
			prune: async () => ({ probes: 0, metrics: 0 }),
			hold: async () => () => undefined,
			freeBytes: () => 1024
		});
		expect(() => m.startCompact()).toThrow(MaintenanceRefused);
	});

	it('streams a backup with a consistent database copy and the Caddyfile, then removes the copy', async () => {
		const { m, dir, db } = setup();
		const { stream, name } = await m.backup();
		expect(name).toMatch(/^caddy-ui-backup-\d{8}T\d{6}Z\.tar\.gz$/);
		expect(m.state().backupRunning).toBe(true);
		// Writes go on while the backup is made and streamed.
		db.prepare(`INSERT INTO settings (key, value) VALUES ('x', 'y')`).run();
		const gz = await collect(stream);
		const out = join(dir, 'out');
		mkdirSync(out);
		writeFileSync(join(out, 'b.tar'), gunzipSync(gz));
		execFileSync('tar', ['-xf', 'b.tar'], { cwd: out });
		expect(readFileSync(join(out, 'Caddyfile'), 'utf8')).toBe('a.example.com {\n\trespond 200\n}\n');
		const copy = new Database(join(out, 'caddy-ui.db'), { readonly: true });
		expect((copy.prepare('SELECT COUNT(*) AS n FROM probes').get() as { n: number }).n).toBe(5_000);
		expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
		copy.close();
		await new Promise((r) => setTimeout(r, 20));
		expect(readdirSync(dir).filter((f) => f.startsWith('.backup-'))).toEqual([]);
		expect(m.state().backupRunning).toBe(false);
	});

	it('writes a valid ustar header', () => {
		const h = tarHeader('Caddyfile', 1234, 0);
		expect(h.length).toBe(512);
		expect(h.subarray(257, 262).toString()).toBe('ustar');
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
		expect(parseInt(h.subarray(148, 154).toString(), 8)).toBe(sum);
	});
});
