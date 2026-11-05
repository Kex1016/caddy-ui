import { describe, expect, it } from 'vitest';
import { frameFor, isStale, missingLine, sourceNotices, type Sources } from './sources';
import { foldUpstreams } from './upstreams';
import { errorRate, statusLine, stepLabel } from './view';

const ok: Sources = {
	caddyfile: { ok: true, error: null, sites: 3 },
	probes: { ok: true, lastRun: 1_000, intervalMs: 30_000 },
	metrics: { ok: true, lastRun: 1_000, error: null, perHost: true },
	logs: { ok: true, found: true, path: '/var/log/caddy/access.log', lastEntry: 900, error: null },
	certs: { ok: true, count: 2, error: null }
};
const empty = (source: 'metrics' | null) => ({ source, points: [] });

describe('sources', () => {
	it('names the fix for traffic without a source', () => {
		const off = { ...ok, metrics: { ...ok.metrics, perHost: false } };
		expect(missingLine('traffic', off)).toContain('metrics { per_host }');
		expect(missingLine('top', { ...ok, logs: { ...ok.logs, found: false } })).toContain('log directive');
	});
	it('marks a chart stale when its source is failing and dates it to the last good data', () => {
		const failing = { ...ok, metrics: { ...ok.metrics, ok: false, error: 'connection refused' } };
		expect(isStale('metrics', failing, 2_000)).toBe(true);
		const f = frameFor(empty('metrics'), failing, 2_000, 'traffic');
		expect(f.stale).toBe(true);
		expect(f.asOf).toBe(1_000);
		expect(f.note).toBe("From Caddy's /metrics");
	});
	it('counts probes as stale after three missed intervals', () => {
		expect(isStale('probes', ok, 1_000 + 60_000)).toBe(false);
		expect(isStale('probes', ok, 1_000 + 120_000)).toBe(true);
	});
	it('raises notices only for sources that need attention', () => {
		expect(sourceNotices(ok)).toEqual([]);
		const n = sourceNotices({ ...ok, metrics: { ...ok.metrics, perHost: false }, admin: { ok: false } });
		expect(n.map((x) => x.title)).toEqual([
			"Caddy's admin API is not answering.",
			'Per-site metrics are off.'
		]);
	});
});

describe('foldUpstreams', () => {
	const u = (address: string, status: 'up' | 'down' | 'unknown', via = 'reverse_proxy') => ({
		address,
		via,
		status,
		since: 0,
		probe: null,
		activeRequests: null,
		fails: null
	});
	it('merges an upstream shared by sites and lists down first', () => {
		const rows = foldUpstreams([
			{
				id: 'a',
				label: 'a.test',
				upstreams: [u('10.0.0.1:80', 'up'), u('10.0.0.101:8888', 'up', 'forward_auth')]
			},
			{ id: 'b', label: 'b.test', upstreams: [u('10.0.0.101:8888', 'down', 'forward_auth')] }
		]);
		expect(rows.map((r) => r.address)).toEqual(['10.0.0.101:8888', '10.0.0.1:80']);
		expect(rows[0]?.status).toBe('down');
		expect(rows[0]?.sites.map((s) => s.id)).toEqual(['a', 'b']);
	});
});

describe('view helpers', () => {
	it('words', () => {
		expect(stepLabel(60_000)).toBe('per minute');
		expect(stepLabel(300_000)).toBe('per 5 minutes');
		expect(stepLabel(21_600_000)).toBe('per 6 hours');
		expect(statusLine('up', 0, 2 * 3_600_000)).toBe('Up for 2h 0m');
		expect(statusLine('unknown', null, 1)).toBe('Not probed yet');
		expect(errorRate(0, 0)).toBe(0);
		expect(errorRate(null, 1)).toBeNull();
	});
});
