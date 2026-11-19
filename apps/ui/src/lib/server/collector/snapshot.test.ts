import { appendFileSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../db';
import { migrations } from '../db/migrations';
import Database from 'better-sqlite3';
import { loadConfig } from '../env';
import { Timing } from '../timing';
import { overview, sitesPayload } from './views';
import { latestProbes, siteSpans, stateSpans, uptimeRatio } from './queries';
import { Snapshot } from './snapshot';
import { siteId } from './sites';
import { insertProbes, prune, pruneInBatches, PRUNE_BATCH, type ProbeRow } from './store';
import { Collector, type CollectorEvent } from './worker';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const TEXT = [
	'a.example.com {',
	'\treverse_proxy 10.0.0.20:80',
	'}',
	'',
	'b.example.com {',
	'\treverse_proxy 10.0.0.21:80',
	'}',
	'',
	'c.example.com {',
	'\trespond "hi"',
	'}',
	''
].join('\n');
const A = siteId(['a.example.com']);
const B = siteId(['b.example.com']);
const C = siteId(['c.example.com']);

let dir: string;
let db: Db;
let now: number;

function env() {
	return loadConfig({
		CADDY_ADMIN_URL: 'http://127.0.0.1:1',
		CADDYFILE_PATH: join(dir, 'Caddyfile'),
		CADDY_LOG_PATH: join(dir, 'access.log'),
		CADDY_DATA_PATH: join(dir, 'data'),
		CADDY_UI_DATA: dir
	});
}

const probe = (siteId: string, target: string, ts: number, ok = true): ProbeRow => ({
	siteId,
	target,
	kind: target.startsWith('https://') ? 'site' : 'upstream',
	ts,
	ok,
	latencyMs: ok ? 12 : null,
	status: ok ? 200 : 502,
	error: ok ? null : 'HTTP 502'
});

function flip(site: string, target: string, ts: number, from: string, to: string) {
	db.prepare(`INSERT INTO state_changes (site_id, ts, "from", "to", target) VALUES (?, ?, ?, ?, ?)`).run(
		site,
		ts,
		from,
		to,
		target
	);
}

/** Runs what the collector does after a probe cycle, without probing anything. */
const emit = (c: Collector, e: CollectorEvent) => (c as unknown as { emit(e: CollectorEvent): void }).emit(e);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'caddy-ui-s0-'));
	writeFileSync(join(dir, 'Caddyfile'), TEXT);
	db = openDb(':memory:');
	now = NOW;
	flip(A, '', NOW - 30 * HOUR, 'unknown', 'up');
	flip(A, '', NOW - 6 * HOUR, 'up', 'down');
	flip(A, '', NOW - 3 * HOUR, 'down', 'up');
	flip(B, '', NOW - 2 * HOUR, 'unknown', 'down');
	flip(A, '10.0.0.20:80', NOW - 30 * HOUR, 'unknown', 'up');
});

describe('probe_latest (migration 4)', () => {
	it('moves with every insert, so the newest probe per target is read without scanning probes', () => {
		insertProbes(db, [probe(A, 'https://a.example.com/', NOW - 60_000, false)]);
		insertProbes(db, [
			probe(A, 'https://a.example.com/', NOW - 30_000),
			probe(A, '10.0.0.20:80', NOW - 30_000)
		]);
		// A late write of an older cycle does not move it back.
		insertProbes(db, [probe(A, 'https://a.example.com/', NOW - 90_000, false)]);
		const latest = latestProbes(db);
		expect(latest.size).toBe(2);
		expect(latest.get(`${A}|https://a.example.com/`)).toEqual({
			target: 'https://a.example.com/',
			ts: NOW - 30_000,
			ok: true,
			latencyMs: 12,
			status: 200,
			error: null
		});
		expect(db.prepare('SELECT COUNT(*) AS n FROM probes').get()).toEqual({ n: 4 });
	});

	it('is added to an existing database without touching its probes, and starts empty', () => {
		const old = new Database(':memory:');
		migrate(old, migrations.slice(0, 3));
		old.exec(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM c WHERE i < 199999)
			INSERT INTO probes SELECT 's' || (i % 35), 't', 'site', i * 1000, 1, 1, 200, NULL FROM c`);
		const t = performance.now();
		migrate(old);
		const ms = performance.now() - t;
		expect(old.pragma('user_version', { simple: true })).toBe(migrations.length);
		expect(old.prepare('SELECT COUNT(*) AS n FROM probe_latest').get()).toEqual({ n: 0 });
		expect(old.prepare('SELECT COUNT(*) AS n FROM probes').get()).toEqual({ n: 200_000 });
		// No backfill: the migration does not depend on how many probes there are.
		expect(ms).toBeLessThan(100);
	});
});

describe('retention', () => {
	it('prunes in batches with a pause between them, and keeps the latest probe of live targets', async () => {
		const old = NOW - 100 * 86_400_000;
		const ins = db.prepare(
			`INSERT INTO probes (site_id, target, kind, ts, ok) VALUES ('s', 't', 'site', ?, 1)`
		);
		db.transaction(() => {
			for (let i = 0; i < PRUNE_BATCH * 2 + 10; i++) ins.run(old + i);
		})();
		insertProbes(db, [probe(A, 'https://a.example.com/', NOW)]);
		db.prepare(
			`INSERT INTO probe_latest (site_id, target, kind, ts, ok) VALUES ('gone', 't', 'site', ?, 1)`
		).run(old);
		let pauses = 0;
		const done = await pruneInBatches(db, 90, NOW, async () => {
			pauses++;
		});
		expect(done).toEqual({ probes: PRUNE_BATCH * 2 + 10, metrics: 0 });
		expect(pauses).toBe(2);
		expect(db.prepare('SELECT COUNT(*) AS n FROM probes').get()).toEqual({ n: 1 });
		expect([...latestProbes(db).keys()]).toEqual([`${A}|https://a.example.com/`]);
		expect(prune(db, 90, NOW)).toEqual({ probes: 0, metrics: 0 });
	});
});

describe('siteSpans', () => {
	it('gives every site the same spans as stateSpans, from one statement', () => {
		const ids = [A, B, C];
		for (const [from, to] of [
			[NOW - 24 * HOUR, NOW],
			[NOW - 4 * HOUR, NOW - HOUR],
			[NOW - 50 * HOUR, NOW - 40 * HOUR]
		] as const) {
			const all = siteSpans(db, ids, from, to);
			for (const id of ids) expect(all.get(id)).toEqual(stateSpans(db, id, '', from, to));
		}
		expect(uptimeRatio(siteSpans(db, [A], NOW - 24 * HOUR, NOW).get(A)!)).toBe(0.875);
	});
});

describe('Snapshot', () => {
	function setup() {
		const c = new Collector(db, env(), () => now);
		const snap = new Snapshot(c, db, () => now);
		c.refreshSites();
		// Sites are probed through Caddy, at the admin URL's host.
		insertProbes(db, [probe(A, 'https://127.0.0.1/', NOW - 10_000), probe(A, '10.0.0.20:80', NOW - 10_000)]);
		return { c, snap };
	}

	it('serves the same sites payload the read side computes, with states from the collector', () => {
		const { c, snap } = setup();
		c.live = {
			at: now,
			data: new Map([['10.0.0.20:80', { address: '10.0.0.20:80', num_requests: 4, fails: 1 }]])
		};
		emit(c, 'probes');
		const got = snap.sitesPayload();
		expect(got).toEqual(sitesPayload(c, db, now));
		const a = got.sites.find((s) => s.id === A)!;
		expect(a).toMatchObject({ status: 'up', since: NOW - 3 * HOUR, uptime24h: 0.875 });
		expect(a.probe).toMatchObject({ ts: NOW - 10_000, ok: true });
		expect(a.upstreams[0]).toMatchObject({ status: 'up', activeRequests: 4, fails: 1 });
		expect(got.sites.find((s) => s.id === B)).toMatchObject({ status: 'down', uptime24h: 0 });
		expect(got.sources.admin).toEqual({ ok: true });
	});

	it('is rebuilt by the collector, not by the request, and reports where its numbers came from', () => {
		const { c, snap } = setup();
		emit(c, 'probes');
		expect(snap.sitesReady).toBe(true);
		const t = new Timing();
		snap.sitesPayload(t);
		expect(t.steps.map((s) => s.name)).toEqual([
			'states',
			'latestProbes',
			'certs',
			'live',
			'spans',
			'snapshot',
			'tail'
		]);
		expect(t.steps[0]?.desc).toBe('snapshot');
		expect(t.header()).toMatch(
			/^states;dur=[\d.]+;desc="snapshot", .*snapshot;desc="age 0 s", tail;desc="lag 0 B", total;dur=/
		);

		// An upstream poll makes the collector rebuild it at once, with the new numbers.
		c.live = { at: now, data: null };
		emit(c, 'upstreams');
		expect(snap.sitesReady).toBe(true);
		expect(snap.sitesPayload().sources.admin).toEqual({ ok: false });
	});

	it('picks up a site added to the Caddyfile', () => {
		const { c, snap } = setup();
		emit(c, 'probes');
		appendFileSync(join(dir, 'Caddyfile'), '\nd.example.com {\n\trespond "new"\n}\n');
		utimesSync(join(dir, 'Caddyfile'), new Date(), new Date(Date.now() + 5_000));
		c.refreshSites();
		expect(snap.sitesReady).toBe(true);
		expect(snap.sitesPayload().sites.map((s) => s.addresses[0])).toEqual([
			'a.example.com',
			'b.example.com',
			'c.example.com',
			'd.example.com'
		]);
	});

	it('has the default Overview ready after a probe cycle, and the same payload as computing it', () => {
		const { c, snap } = setup();
		const cold = snap.overviewParts('24h');
		expect(cold.traffic).toBeInstanceOf(Promise);
		emit(c, 'probes');
		const parts = snap.overviewParts('24h');
		expect(parts.traffic).not.toBeInstanceOf(Promise);
		expect(parts.top).not.toBeInstanceOf(Promise);
		expect(snap.overview('24h')).toEqual(overview(c, db, '24h', now));
		expect(parts.status.tiles.sites).toEqual({ up: 1, down: 1, unknown: 1, total: 3 });
	});

	it('streams other ranges once, then remembers them for one step of the range (five minutes at most)', async () => {
		const { c, snap } = setup();
		emit(c, 'probes');
		const t = new Timing();
		const first = snap.overviewParts('7d', t);
		expect(first.traffic).toBeInstanceOf(Promise);
		expect(first.top).toBeInstanceOf(Promise);
		const traffic = await first.traffic;
		expect(traffic).toEqual(expect.objectContaining({ range: '7d', stepMs: HOUR }));
		await first.top;
		expect(t.steps.filter((s) => s.desc === 'streamed').map((s) => s.name)).toEqual(
			expect.arrayContaining(['traffic', 'process', 'traffic-part', 'topSites', 'top', 'top-part'])
		);

		now += 4 * 60_000;
		expect(snap.overviewParts('7d').traffic).not.toBeInstanceOf(Promise);
		now += 2 * 60_000;
		expect(snap.overviewParts('7d').traffic).toBeInstanceOf(Promise);
		// 1h steps by the minute, so it is remembered for a minute.
		await snap.overviewParts('1h').traffic;
		now += 30_000;
		expect(snap.overviewParts('1h').traffic).not.toBeInstanceOf(Promise);
		now += 31_000;
		expect(snap.overviewParts('1h').traffic).toBeInstanceOf(Promise);
		// The API never streams: it gets the whole payload, in its §3.2 shape. What is up is from the last cycle.
		const { asOf, ...api } = snap.overview('30d');
		expect(asOf).toBe(NOW);
		expect(api).toEqual({ ...overview(c, db, '30d', now), asOf: undefined });
	});
});
