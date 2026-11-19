import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, type Db } from '../db';
import { migrations } from '../db/migrations';
import { loadConfig } from '../env';
import { Snapshot } from './snapshot';
import { requestsBySite, topLists, traffic, window } from './queries';
import { siteId } from './sites';
import { overview, sitesPayload } from './views';
import { Collector, type CollectorEvent } from './worker';

/**
 * docs/settings-and-perf-plan.md §1.3 G: the two pages' payloads stay fast on a database that has run for the
 * full 90-day retention with 35 sites, each behind one upstream, probed every 30 s (18 million probe rows),
 * with the access log rolled up per site and minute for the same 90 days. Run with `pnpm test:perf`; CI runs
 * it in its own job. Seeding takes about a minute and 3 GB of disk.
 */

const BUDGET_MS = 200;
const DAYS = 90;
const SITES = 35;
const PROBE_MS = 30_000;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const DAY = 86_400_000;

let dir: string;
let db: Db;
let c: Collector;
const timings: Record<string, number | string> = {};

const hosts = Array.from({ length: SITES }, (_, i) => `site${i}.example.com`);

function seed(d: Db) {
	const probes = Math.floor((DAYS * DAY) / PROBE_MS);
	const minutes = DAYS * 1440;
	// Rows in time order, as the collector writes them.
	d.exec(`
		WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM c WHERE i < ${probes - 1}),
		  s(j, id) AS (SELECT key, value FROM json_each('${JSON.stringify(hosts.map((h) => siteId([h])))}')),
		  k(k) AS (SELECT 0 UNION ALL SELECT 1)
		INSERT INTO probes (site_id, target, kind, ts, ok, latency_ms, status, error)
		SELECT s.id, CASE k WHEN 0 THEN 'https://127.0.0.1/' ELSE '10.0.0.' || (s.j + 20) || ':80' END,
		  CASE k WHEN 0 THEN 'site' ELSE 'upstream' END, ${NOW} - (${probes} - i) * ${PROBE_MS},
		  (i + s.j) % 997 != 0, 10 + (i % 40), 200, NULL
		FROM c, s, k;

		WITH RECURSIVE m(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM m WHERE i < ${minutes - 1}),
		  ids(id) AS (SELECT value FROM json_each('${JSON.stringify(['*', ...hosts.map((h) => siteId([h]))])}'))
		INSERT INTO log_minutes
		SELECT ids.id, ${NOW} - (${minutes} - i) * 60000, 20 + (i % 17), i % 3, (i % 50 = 0), 40000 + i % 1000, 12.5, 48,
		  '[["/",9],["/api/status",5],["/assets/app.js",3],["/favicon.ico",2],["/login",1]]',
		  '[["198.51.100.4",8],["198.51.100.9",6],["203.0.113.7",4],["192.0.2.1",2]]'
		FROM m, ids;

		WITH RECURSIVE m(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM m WHERE i < ${minutes - 1}),
		  n(name) AS (VALUES ('requests'), ('errors_4xx'), ('errors_5xx'), ('bytes_out'), ('latency_p50_ms'),
		    ('latency_p95_ms'), ('in_flight'), ('process_resident_memory_bytes'), ('go_goroutines'))
		INSERT INTO metric_samples (ts, name, labels_json, value)
		SELECT ${NOW} - (${minutes} - i) * 60000, name, '{"site":"*"}', i % 100 FROM m, n;
	`);
	// A few flips per site over the 90 days, so the uptime query has history to read.
	const flip = d.prepare(
		`INSERT INTO state_changes (site_id, ts, "from", "to", target) VALUES (?, ?, ?, ?, ?)`
	);
	d.transaction(() => {
		hosts.forEach((h, j) => {
			const id = siteId([h]);
			flip.run(id, NOW - DAYS * DAY, 'unknown', 'up', '');
			flip.run(id, NOW - DAYS * DAY, 'unknown', 'up', `10.0.0.${j + 20}:80`);
			for (let day = DAYS - 1; day > 0; day -= 7) {
				flip.run(id, NOW - day * DAY, 'up', 'down', '');
				flip.run(id, NOW - day * DAY + 120_000, 'down', 'up', '');
			}
		});
	})();
}

function time<T>(name: string, fn: () => T, runs = 5): { value: T; worst: number } {
	let value!: T;
	let worst = 0;
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		value = fn();
		worst = Math.max(worst, performance.now() - t);
	}
	timings[name] = Math.round(worst * 10) / 10;
	return { value, worst };
}

beforeAll(() => {
	// PERF_DB=/some/path.db keeps the seeded database there and reuses it on the next run (local tuning only).
	const keep = process.env.PERF_DB;
	dir = mkdtempSync(join(tmpdir(), 'caddy-ui-perf-'));
	writeFileSync(
		join(dir, 'Caddyfile'),
		hosts.map((h, j) => `${h} {\n\treverse_proxy 10.0.0.${j + 20}:80\n}\n`).join('\n')
	);
	const path = keep ?? join(dir, 'caddy-ui.db');
	const reuse = keep !== undefined && existsSync(keep);
	db = new Database(path);
	db.pragma('journal_mode = WAL');
	if (!reuse) {
		// The database as 1.1 left it (schema 3), seeded, then upgraded the way a new image would on boot.
		migrate(db, migrations.slice(0, 3));
		let t = performance.now();
		seed(db);
		timings.seedS = Math.round(performance.now() - t) / 1000;
		t = performance.now();
		migrate(db);
		timings.migrateMs = Math.round(performance.now() - t);
	} else migrate(db);
	timings.dbMb = Math.round(statSync(path).size / 1e6);
	timings.probeRows = (db.prepare('SELECT COUNT(*) AS n FROM probes').get() as { n: number }).n;
	timings.logMinuteRows = (db.prepare('SELECT COUNT(*) AS n FROM log_minutes').get() as { n: number }).n;

	c = new Collector(
		db,
		loadConfig({
			CADDY_ADMIN_URL: 'http://127.0.0.1:1',
			CADDYFILE_PATH: join(dir, 'Caddyfile'),
			CADDY_LOG_PATH: join(dir, 'access.log'),
			CADDY_DATA_PATH: join(dir, 'data'),
			CADDY_UI_DATA: dir
		}),
		() => NOW
	);
	c.refreshSites();
	// probe_latest fills on the first probe cycle after the upgrade; this is what that cycle writes.
	db.exec(`INSERT OR REPLACE INTO probe_latest SELECT site_id, target, kind, ts, ok, latency_ms, status, error FROM probes
		WHERE ts = (SELECT MAX(ts) FROM probes)`);
}, 600_000);

afterAll(() => {
	console.log(`S0 performance on ${DAYS} days × ${SITES} sites:`, JSON.stringify(timings));
	db?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe(`pages on ${DAYS} days of data for ${SITES} sites`, () => {
	it('the schema 4 migration does not depend on the number of probe rows', () => {
		expect(timings.probeRows).toBe(Math.floor((DAYS * DAY) / PROBE_MS) * SITES * 2);
		// It only builds the log_minutes index; probes are not read or rewritten.
		if (timings.migrateMs !== undefined) expect(timings.migrateMs as number).toBeLessThan(10_000);
	});

	it(`builds the sites payload in under ${BUDGET_MS} ms`, () => {
		const { value, worst } = time('sitesPayloadMs', () => sitesPayload(c, db, NOW));
		expect(value.sites).toHaveLength(SITES);
		expect(value.sites.every((s) => s.probe !== null && s.uptime24h !== null)).toBe(true);
		expect(worst).toBeLessThan(BUDGET_MS);
	});

	it(`builds the 24 h Overview in under ${BUDGET_MS} ms`, () => {
		const { value, worst } = time('overview24hMs', () => overview(c, db, '24h', NOW));
		expect(value.tiles.requests.source).toBe('logs');
		expect(value.topSites).toHaveLength(10);
		expect(value.top?.paths.length).toBeGreaterThan(0);
		expect(worst).toBeLessThan(BUDGET_MS);
	});

	it('serves both pages from the snapshot in a few milliseconds', () => {
		const snap = new Snapshot(c, db, () => NOW);
		(c as unknown as { emit(e: CollectorEvent): void }).emit('probes');
		const { worst: sitesMs } = time('snapshotSitesMs', () => snap.sitesPayload());
		const { worst: overviewMs } = time('snapshotOverviewMs', () => snap.overviewParts('24h'));
		expect(sitesMs).toBeLessThan(5);
		expect(overviewMs).toBeLessThan(5);
	});

	it('reports the other ranges (streamed, not budgeted)', () => {
		for (const r of ['1h', '7d', '30d'] as const) {
			const w = window(r, NOW);
			time(`traffic${r}Ms`, () => traffic(db, '*', w), 1);
			time(`top${r}Ms`, () => topLists(db, '*', w), 1);
			time(`bySite${r}Ms`, () => requestsBySite(db, w), 1);
			time(`overview${r}Ms`, () => overview(c, db, r, NOW), 1);
		}
	});
});
