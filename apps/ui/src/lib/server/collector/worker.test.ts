import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { loadConfig } from '../env';
import { overview, siteStats, sitesPayload } from '.';
import { siteId } from './sites';
import { prune } from './store';
import { Collector } from './worker';

/**
 * End to end against a fake Caddy: one HTTP server plays the admin API (/metrics, /reverse_proxy/upstreams)
 * and the sites (answering by Host), and plain TCP servers play the upstreams.
 */

let caddy: http.Server;
let upstream: net.Server;
let port = 0;
let upPort = 0;
let closedPort = 0;
let requests = 0;

const listen = (s: net.Server) =>
	new Promise<number>((resolve) =>
		s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port))
	);

function metricsPage() {
	const host = (h: string, n: number, code = 200) =>
		[
			`caddy_http_request_duration_seconds_bucket{code="${code}",handler="subroute",host="${h}",method="GET",server="srv0",le="0.01"} ${Math.floor(n / 2)}`,
			`caddy_http_request_duration_seconds_bucket{code="${code}",handler="subroute",host="${h}",method="GET",server="srv0",le="0.1"} ${n}`,
			`caddy_http_request_duration_seconds_bucket{code="${code}",handler="subroute",host="${h}",method="GET",server="srv0",le="+Inf"} ${n}`,
			`caddy_http_request_duration_seconds_count{code="${code}",handler="subroute",host="${h}",method="GET",server="srv0"} ${n}`,
			`caddy_http_response_size_bytes_sum{code="${code}",handler="subroute",host="${h}",method="GET",server="srv0"} ${n * 100}`
		].join('\n');
	return [
		host('up.test', requests),
		host('down.test', Math.floor(requests / 10), 502),
		`caddy_http_requests_in_flight{handler="subroute",server="srv0"} 2`,
		'process_start_time_seconds 1.7e+09',
		'process_resident_memory_bytes 4e+07',
		'go_goroutines 30'
	].join('\n');
}

let dir: string;
let cfgEnv: Record<string, string>;

beforeAll(async () => {
	caddy = http.createServer((req, res) => {
		const host = (req.headers.host ?? '').replace(/:\d+$/, '');
		if (req.url === '/metrics') return res.end(metricsPage());
		if (req.url === '/reverse_proxy/upstreams') {
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify([{ address: `127.0.0.1:${upPort}`, num_requests: 3, fails: 0 }]));
		}
		if (host === 'up.test') return res.end('ok');
		if (host === 'down.test') {
			res.statusCode = 502;
			return res.end();
		}
		if (host === 'redir.test') {
			if (req.url === '/') {
				res.statusCode = 308;
				res.setHeader('location', '/home');
				return res.end();
			}
			if (req.url === '/home') {
				res.statusCode = 503;
				return res.end();
			}
		}
		res.statusCode = 404;
		res.end();
	});
	port = await listen(caddy);
	upstream = net.createServer((s) => s.end());
	upPort = await listen(upstream);
	const probe = net.createServer();
	closedPort = await listen(probe);
	await new Promise((r) => probe.close(r));

	dir = mkdtempSync(join(tmpdir(), 'caddy-ui-worker-'));
	writeFileSync(
		join(dir, 'Caddyfile'),
		[
			`http://up.test:${port} {`,
			`\treverse_proxy 127.0.0.1:${upPort}`,
			`}`,
			`http://down.test:${port} {`,
			`\treverse_proxy 127.0.0.1:${closedPort}`,
			`}`,
			`http://redir.test:${port} {`,
			`\trespond 200`,
			`}`,
			''
		].join('\n')
	);
	writeFileSync(join(dir, 'access.log'), '');
	cfgEnv = {
		CADDY_ADMIN_URL: `http://127.0.0.1:${port}`,
		CADDYFILE_PATH: join(dir, 'Caddyfile'),
		CADDY_LOG_PATH: join(dir, 'access.log'),
		CADDY_DATA_PATH: join(dir, 'data'),
		CADDY_UI_DATA: dir,
		CADDY_UI_PROBE_INTERVAL: '6s'
	};
});

afterAll(async () => {
	await new Promise((r) => caddy.close(r));
	await new Promise((r) => upstream.close(r));
});

describe('Collector', () => {
	it('probes sites and upstreams, tracks state, scrapes metrics and tails the log', async () => {
		let now = Date.UTC(2026, 10, 5, 12, 0, 5);
		const db = openDb(':memory:');
		const c = new Collector(db, loadConfig(cfgEnv), () => now);
		const id = (h: string) => siteId([`http://${h}:${port}`]);

		await c.probeAll();
		await c.pollUpstreams();
		let sites = sitesPayload(c, db, now);
		const by = (h: string) => sites.sites.find((s) => s.id === id(h))!;
		expect(sites.sites).toHaveLength(3);
		expect(by('up.test')).toMatchObject({ status: 'up', since: now });
		expect(by('up.test').probe).toMatchObject({ ok: true, status: 200 });
		expect(by('up.test').upstreams[0]).toMatchObject({ status: 'up', activeRequests: 3, fails: 0 });
		expect(by('down.test')).toMatchObject({ status: 'down' });
		expect(by('down.test').probe).toMatchObject({ ok: false, status: 502, error: 'HTTP 502' });
		expect(by('down.test').upstreams[0]?.status).toBe('down');
		// The same-host redirect is followed, and the 503 behind it is what counts.
		expect(by('redir.test')).toMatchObject({ status: 'down' });

		// Take the upstream away: it must show down on the very next probe cycle.
		await new Promise((r) => upstream.close(r));
		const firstUp = now;
		now += 6_000;
		await c.probeAll();
		await c.pollUpstreams();
		sites = sitesPayload(c, db, now);
		expect(by('up.test').upstreams[0]).toMatchObject({ status: 'down', since: now });
		expect(by('up.test')).toMatchObject({ status: 'up', since: firstUp }); // the site itself still answers
		upstream = net.createServer((s) => s.end());
		await new Promise<void>((r) => upstream.listen(upPort, '127.0.0.1', () => r()));

		// Metrics: a baseline, then growth inside the minute, then the minute closes.
		requests = 100;
		await c.scrapeMetrics();
		requests = 160;
		now += 15_000;
		await c.scrapeMetrics();
		now += 60_000;
		await c.scrapeMetrics();
		expect(c.status.metrics).toMatchObject({ error: null, perHost: true });

		const ov = await overview(c, db, '1h', now);
		expect(ov.tiles.requests).toEqual({ value: 66, source: 'metrics' }); // 60 on up.test + 6 on down.test
		expect(ov.tiles.sites).toEqual({ up: 1, down: 2, unknown: 0, total: 3 });
		expect(ov.tiles.caddyStartedAt).toEqual({ value: 1.7e12, source: 'metrics' });
	});

	it('attributes per-host metrics and log lines to sites', async () => {
		let now = Date.UTC(2026, 10, 5, 13, 0, 5);
		const db = openDb(':memory:');
		const c = new Collector(db, loadConfig(cfgEnv), () => now);
		c.refreshSites();
		const up = siteId([`http://up.test:${port}`]);

		requests = 0;
		await c.scrapeMetrics();
		requests = 50;
		now += 15_000;
		await c.scrapeMetrics();
		now += 60_000;
		await c.scrapeMetrics();

		let ov = await overview(c, db, '1h', now);
		expect(ov.tiles.requests.value).toBe(55); // 50 on up.test + 5 on down.test
		expect(ov.tiles.errorRate.value).toBeCloseTo(5 / 55, 3);
		expect(ov.topSites[0]).toMatchObject({ siteId: up, requests: 50, source: 'metrics' });
		expect(ov.series.memory.points.some(([, v]) => v === 4e7)).toBe(true);

		let stats = siteStats(c, db, up, '1h', now)!;
		expect(stats.totals.requests).toBe(50);
		expect(stats.series.requests.source).toBe('metrics');
		expect(stats.totals.latencyP50).toBeGreaterThan(0);

		// The access log wins over metrics once it has data in the window.
		await c.tailLogs(); // first sight: start at the end
		const line = (ts: number, uri: string, status: number) =>
			JSON.stringify({
				ts: ts / 1000,
				logger: 'http.log.access',
				msg: 'handled request',
				request: { client_ip: '198.51.100.4', host: `up.test:${port}`, uri, method: 'GET' },
				duration: 0.02,
				size: 1234,
				status
			}) + '\n';
		appendFileSync(
			cfgEnv.CADDY_LOG_PATH as string,
			line(now, '/a', 200) + line(now + 1000, '/a', 200) + line(now + 2000, '/b?x', 500)
		);
		await c.tailLogs();
		now += 90_000;
		await c.tailLogs();
		stats = siteStats(c, db, up, '1h', now)!;
		expect(stats.series.requests.source).toBe('logs');
		expect(stats.totals).toMatchObject({ requests: 3, errors5xx: 1, bytesOut: 3 * 1234 });
		expect(stats.top?.paths).toEqual([
			['/a', 2],
			['/b', 1]
		]);
		expect(stats.top?.ips).toEqual([['198.51.100.4', 3]]);
		expect(c.status.logs).toMatchObject({ found: true, error: null });

		ov = await overview(c, db, '24h', now);
		expect(ov.tiles.requests).toEqual({ value: 3, source: 'logs' });
		expect(siteStats(c, db, 'nope', '1h', now)).toBeUndefined();
	});

	it('reads a large log backlog in slices, yields between them, and reports how far behind it is', async () => {
		const now = Date.UTC(2026, 10, 5, 14, 0, 5);
		const logPath = join(dir, 'busy.log');
		writeFileSync(logPath, '');
		const c = new Collector(
			openDb(':memory:'),
			loadConfig({ ...cfgEnv, CADDY_LOG_PATH: logPath }),
			() => now
		);
		c.refreshSites();
		await c.tailLogs(); // first sight: start at the end
		const line =
			JSON.stringify({
				ts: now / 1000,
				request: { client_ip: '198.51.100.4', host: `up.test:${port}`, uri: '/x', method: 'GET' },
				duration: 0.01,
				size: 10,
				status: 200
			}) + '\n';
		// About 10 MB: more than one tick reads (8 slices of 1 MB).
		const n = Math.ceil((10 * 1024 * 1024) / line.length);
		appendFileSync(logPath, line.repeat(n));
		let pauses = 0;
		await c.tailLogs(async () => {
			pauses++;
		});
		expect(pauses).toBe(7);
		expect(c.status.logs.lagBytes).toBeGreaterThan(1024 * 1024);
		expect(c.status.logs.lagBytes).toBeLessThan(3 * 1024 * 1024);
		await c.tailLogs(async () => {});
		expect(c.status.logs.lagBytes).toBe(0);
		expect(c.status.logs.error).toBeNull();
	});

	it('leaves out requests from excluded networks, and takes a new list without a restart', async () => {
		let now = Date.UTC(2026, 10, 5, 16, 0, 5);
		const logPath = join(dir, 'docker.log');
		writeFileSync(logPath, '');
		const db = openDb(':memory:');
		const c = new Collector(db, loadConfig({ ...cfgEnv, CADDY_LOG_PATH: logPath }), () => now);
		c.refreshSites();
		const up = siteId([`http://up.test:${port}`]);
		await c.tailLogs(); // first sight: start at the end
		const line = (ts: number, ip: string) =>
			JSON.stringify({
				ts: ts / 1000,
				request: { remote_ip: ip, host: `up.test:${port}`, uri: '/health', method: 'GET' },
				duration: 0.01,
				size: 10,
				status: 200
			}) + '\n';
		// Only Docker and loopback traffic in the first minute: it is read, but counts as zero requests.
		appendFileSync(
			logPath,
			line(now, '172.18.0.5') + line(now + 1000, '::ffff:127.0.0.1') + line(now + 2000, '::1')
		);
		await c.tailLogs();
		now += 90_000;
		await c.tailLogs();
		expect(c.status.logs.excluded).toBe(3);
		let stats = siteStats(c, db, up, '1h', now)!;
		expect(stats.series.requests.source).toBe('logs');
		expect(stats.totals.requests).toBe(0);
		expect(db.prepare(`SELECT requests FROM log_minutes WHERE site_id = '*'`).all()).toEqual([
			{ requests: 0 }
		]);

		// A LAN or public client is still counted next to Docker traffic.
		appendFileSync(logPath, line(now, '10.0.0.7') + line(now + 1000, '172.20.1.2'));
		await c.tailLogs();
		now += 90_000;
		await c.tailLogs();
		stats = siteStats(c, db, up, '1h', now)!;
		expect(stats.totals.requests).toBe(1);
		expect(stats.top?.ips).toEqual([['10.0.0.7', 1]]);

		// "none" counts everything again from the next line on.
		c.reconfigure(loadConfig({ ...cfgEnv, CADDY_LOG_PATH: logPath, CADDY_UI_LOG_EXCLUDE_NETWORKS: 'none' }));
		appendFileSync(logPath, line(now, '172.18.0.5'));
		await c.tailLogs();
		now += 90_000;
		await c.tailLogs();
		expect(siteStats(c, db, up, '1h', now)!.totals.requests).toBe(2);
		expect(c.status.logs.excluded).toBe(4);
		c.stop();
	});

	it('keeps minute rollups and drops raw rows past retention', () => {
		const db = openDb(':memory:');
		const old = Date.UTC(2026, 0, 1);
		db.prepare(`INSERT INTO probes (site_id, target, kind, ts, ok) VALUES ('s', 't', 'site', ?, 1)`).run(old);
		db.prepare(
			`INSERT INTO metric_samples (ts, name, labels_json, value) VALUES (?, 'requests', '{"site":"*"}', 1)`
		).run(old);
		db.prepare(`INSERT INTO log_minutes VALUES ('*', ?, 1, 0, 0, 0, NULL, NULL, '[]', '[]')`).run(old);
		expect(prune(db, 90, Date.UTC(2026, 10, 5))).toEqual({ probes: 1, metrics: 1 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM log_minutes').get()).toEqual({ n: 1 });
	});
});
