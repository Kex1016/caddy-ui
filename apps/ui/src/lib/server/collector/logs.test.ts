import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTailer, LogRollup, parseAccessLine, percentile } from './logs';

const T = Date.UTC(2026, 10, 5, 12, 0, 0);

function line(o: {
	ts?: number;
	host?: string;
	uri?: string;
	status?: number;
	duration?: number;
	size?: number;
	ip?: string;
}) {
	return JSON.stringify({
		level: 'info',
		ts: (o.ts ?? T) / 1000,
		logger: 'http.log.access.log0',
		msg: 'handled request',
		request: {
			remote_ip: '10.0.0.1',
			client_ip: o.ip ?? '203.0.113.7',
			proto: 'HTTP/2.0',
			method: 'GET',
			host: o.host ?? 'app.example.com',
			uri: o.uri ?? '/index.html?x=1',
			headers: {}
		},
		bytes_read: 0,
		duration: o.duration ?? 0.012,
		size: o.size ?? 512,
		status: o.status ?? 200
	});
}

describe('parseAccessLine', () => {
	it('reads Caddy JSON access entries', () => {
		expect(parseAccessLine(line({}))).toEqual({
			ts: T,
			host: 'app.example.com',
			path: '/index.html',
			status: 200,
			durationMs: 12,
			bytes: 512,
			ip: '203.0.113.7'
		});
	});
	it('skips other log lines', () => {
		expect(parseAccessLine('{"level":"info","msg":"serving initial configuration"}')).toBeUndefined();
		expect(parseAccessLine('not json')).toBeUndefined();
	});
});

describe('percentile', () => {
	it('uses nearest rank', () => {
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
		expect(percentile([], 0.5)).toBeNull();
	});
});

describe('LogRollup', () => {
	it('groups by site and minute and hands out closed minutes', () => {
		const r = new LogRollup((h) => (h === 'app.example.com' ? 'APP' : undefined), 10_000);
		for (let i = 0; i < 10; i++)
			r.add(parseAccessLine(line({ ts: T + i * 1000, duration: (i + 1) / 1000 }))!);
		r.add(parseAccessLine(line({ ts: T + 2000, status: 502, uri: '/api' }))!);
		r.add(parseAccessLine(line({ ts: T + 3000, status: 404, host: 'unknown.test' }))!);
		r.add(parseAccessLine(line({ ts: T + 61_000 }))!);
		expect(r.take(T + 65_000)).toHaveLength(0); // still inside the grace period
		const rows = r.take(T + 71_000);
		const app = rows.find((x) => x.siteId === 'APP');
		const all = rows.find((x) => x.siteId === '*');
		const none = rows.find((x) => x.siteId === '');
		expect(app).toMatchObject({ minute: T, requests: 11, errors5xx: 1, errors4xx: 0, bytesOut: 11 * 512 });
		expect(app?.topPaths[0]).toEqual(['/index.html', 10]);
		expect(app?.topIps).toEqual([['203.0.113.7', 11]]);
		expect(all?.requests).toBe(12);
		expect(none).toMatchObject({ requests: 1, errors4xx: 1 });
		expect(r.take(T + 200_000, true).map((x) => x.minute)).toEqual([T + 60_000, T + 60_000]);
	});
});

describe('FileTailer', () => {
	it('starts at the end, reads appended lines, keeps half lines for later and follows rotation', () => {
		const dir = mkdtempSync(join(tmpdir(), 'caddy-ui-tail-'));
		const path = join(dir, 'access.log');
		const existing = join(dir, 'existing.log');
		writeFileSync(existing, 'old\n');
		const e = new FileTailer(existing, undefined);
		expect(e.read()).toEqual([]); // an existing file: skip its history
		appendFileSync(existing, 'new\n');
		expect(e.read()).toEqual(['new']);

		const t = new FileTailer(path, undefined);
		expect(t.read()).toEqual([]); // missing file
		writeFileSync(path, 'first\n');
		expect(t.read()).toEqual(['first']); // appeared later: read from the top
		appendFileSync(path, 'one\ntw');
		expect(t.read()).toEqual(['one']);
		appendFileSync(path, 'o\n');
		expect(t.read()).toEqual(['two']);
		renameSync(path, join(dir, 'access-1.log'));
		writeFileSync(path, 'fresh\n');
		expect(t.read()).toEqual(['fresh']);
		// A saved position resumes where it left off.
		appendFileSync(path, 'later\n');
		const resumed = new FileTailer(path, t.position);
		expect(resumed.read()).toEqual(['later']);
	});
});
