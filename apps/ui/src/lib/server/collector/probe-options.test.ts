import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { loadConfig } from '../env';
import { sitesPayload } from '.';
import {
	describeOptions,
	loadProbeOptions,
	parsePath,
	parseProbeOptions,
	parseStatuses,
	ProbeOptionsError,
	saveProbeOptions,
	withPath
} from './probe-options';
import { siteId } from './sites';
import { Collector, probeTimeout } from './worker';

describe('parsing', () => {
	it('takes a path that starts with one slash, with a query, or nothing', () => {
		expect(parsePath(' /health ')).toBe('/health');
		expect(parsePath('/status?full=1')).toBe('/status?full=1');
		expect(parsePath('')).toBeNull();
		expect(() => parsePath('health')).toThrow(ProbeOptionsError);
		expect(() => parsePath('//evil.example')).toThrow(/single \//);
		expect(() => parsePath('/a b')).toThrow(/no spaces/);
	});

	it('takes statuses as a list, sorted and without repeats', () => {
		expect(parseStatuses('503, 401 503')).toEqual([401, 503]);
		expect(parseStatuses('')).toEqual([]);
		expect(() => parseStatuses('5xx')).toThrow(/not an HTTP status/);
		expect(() => parseStatuses('700')).toThrow(/not an HTTP status/);
	});

	it('reads the form, naming the field that is wrong', () => {
		expect(parseProbeOptions({ skip: true, path: '/up', upStatuses: '503' })).toEqual({
			skip: true,
			path: '/up',
			upStatuses: [503]
		});
		try {
			parseProbeOptions({ skip: false, path: 'x', upStatuses: '' });
			expect.unreachable();
		} catch (err) {
			expect((err as ProbeOptionsError).field).toBe('path');
		}
	});

	it('replaces the path and query of a target', () => {
		expect(withPath('https://10.0.0.1/', '/health?x=1')).toBe('https://10.0.0.1/health?x=1');
		expect(withPath('http://10.0.0.1:8080/app/', null)).toBe('http://10.0.0.1:8080/app/');
	});

	it('describes options in one line', () => {
		expect(describeOptions({ skip: false, path: null, upStatuses: [] })).toBe('as usual');
		expect(describeOptions({ skip: true, path: '/h', upStatuses: [503] })).toBe(
			'not probed · path /h · also up: 503'
		);
	});
});

describe('storage', () => {
	it('saves, logs each change once, and removes the row when back to the defaults', () => {
		const db = openDb(':memory:');
		const site = { id: 'abc', label: 'app.example.com' };
		expect(saveProbeOptions(db, site, { skip: false, path: '/h', upStatuses: [503] }, 'david', 1)).toBe(true);
		expect(saveProbeOptions(db, site, { skip: false, path: '/h', upStatuses: [503] }, 'david', 2)).toBe(
			false
		);
		expect(loadProbeOptions(db).get('abc')).toEqual({ skip: false, path: '/h', upStatuses: [503] });
		expect(saveProbeOptions(db, site, { skip: false, path: null, upStatuses: [] }, 'david', 3)).toBe(true);
		expect(loadProbeOptions(db).size).toBe(0);
		const log = db.prepare(`SELECT key, old_value, new_value FROM settings_log ORDER BY id`).all();
		expect(log).toEqual([
			{ key: 'probe:app.example.com', old_value: 'as usual', new_value: 'path /h · also up: 503' },
			{ key: 'probe:app.example.com', old_value: 'path /h · also up: 503', new_value: 'as usual' }
		]);
	});
});

describe('the probe timeout', () => {
	it('is automatic unless set, and never longer than the interval', () => {
		expect(probeTimeout(30_000)).toBe(10_000);
		expect(probeTimeout(3_000)).toBe(2_000);
		expect(probeTimeout(30_000, 4_000)).toBe(4_000);
		expect(probeTimeout(5_000, 20_000)).toBe(5_000);
	});
});

describe('the collector with probe options', () => {
	let caddy: http.Server;
	let port = 0;
	let dir: string;
	const seen: string[] = [];

	beforeAll(async () => {
		caddy = http.createServer((req, res) => {
			const host = (req.headers.host ?? '').replace(/:\d+$/, '');
			seen.push(`${host}${req.url}`);
			if (host === 'maint.test') {
				res.statusCode = 503;
				return res.end();
			}
			if (host === 'health.test') {
				res.statusCode = req.url === '/health' ? 200 : 502;
				return res.end();
			}
			res.end('ok');
		});
		await new Promise<void>((r) => caddy.listen(0, '127.0.0.1', () => r()));
		port = (caddy.address() as { port: number }).port;
		dir = mkdtempSync(join(tmpdir(), 'caddy-ui-probe-options-'));
		writeFileSync(
			join(dir, 'Caddyfile'),
			['maint', 'health', 'skip'].map((h) => `http://${h}.test:${port} {\n\trespond 200\n}\n`).join('')
		);
	});
	afterAll(() => new Promise((r) => caddy.close(r)));

	it('skips a site, probes another path, and counts an extra status as up', async () => {
		const db = openDb(':memory:');
		const cfg = loadConfig({
			CADDY_ADMIN_URL: `http://127.0.0.1:${port}`,
			CADDYFILE_PATH: join(dir, 'Caddyfile'),
			CADDY_LOG_PATH: join(dir, 'access.log'),
			CADDY_UI_DATA: dir
		});
		const id = (h: string) => siteId([`http://${h}.test:${port}`]);
		const c = new Collector(db, cfg, () => 1_000);
		await c.probeAll();
		let by = (h: string) => sitesPayload(c, db, 1_000).sites.find((s) => s.id === id(h))!;
		expect(by('maint').status).toBe('down');
		expect(by('health').status).toBe('down');
		expect(by('skip').status).toBe('up');

		saveProbeOptions(
			db,
			{ id: id('maint'), label: 'maint' },
			{ skip: false, path: null, upStatuses: [503] },
			'd',
			2
		);
		saveProbeOptions(
			db,
			{ id: id('health'), label: 'health' },
			{ skip: false, path: '/health', upStatuses: [] },
			'd',
			2
		);
		saveProbeOptions(
			db,
			{ id: id('skip'), label: 'skip' },
			{ skip: true, path: null, upStatuses: [] },
			'd',
			2
		);
		c.setProbeOptions(loadProbeOptions(db));
		seen.length = 0;
		await c.probeAll();
		by = (h: string) => sitesPayload(c, db, 2_000).sites.find((s) => s.id === id(h))!;
		expect(by('maint')).toMatchObject({ status: 'up', probeSkipped: false });
		expect(by('maint').probe).toMatchObject({ ok: true, status: 503 });
		expect(by('health').status).toBe('up');
		expect(by('health').probe?.target).toBe(`http://127.0.0.1:${port}/health`);
		expect(by('skip')).toMatchObject({ status: 'unknown', probeSkipped: true });
		expect(seen.some((s) => s.startsWith('skip.test'))).toBe(false);
		expect(seen).toContain('health.test/health');
	});

	it('holds the writing jobs until released', async () => {
		const db = openDb(':memory:');
		const c = new Collector(
			db,
			loadConfig({ CADDY_ADMIN_URL: `http://127.0.0.1:${port}`, CADDYFILE_PATH: join(dir, 'Caddyfile') })
		);
		const release = await c.hold();
		expect(c.holding).toBe(true);
		release();
		expect(c.holding).toBe(false);
	});
});
