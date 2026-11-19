import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db';
import { loadConfig } from '../env';
import { Collector } from './worker';

/** Live re-configuration (docs/settings-and-perf-plan.md §2.2): new intervals re-arm the timers at once. */

const base = loadConfig({
	CADDYFILE_PATH: '/nonexistent/Caddyfile',
	CADDY_LOG_PATH: '/nonexistent/access.log',
	CADDY_DATA_PATH: '/nonexistent/data',
	CADDY_ADMIN_URL: 'http://127.0.0.1:1',
	CADDY_UI_PROBE_INTERVAL: '1m',
	CADDY_UI_SCRAPE_INTERVAL: '30s'
});

function collector() {
	const c = new Collector(openDb(':memory:'), base);
	const calls = { probes: 0, metrics: 0, prune: 0 };
	c.probeAll = vi.fn(async () => {
		calls.probes++;
	});
	c.scrapeMetrics = vi.fn(async () => {
		calls.metrics++;
	});
	c.pollUpstreams = vi.fn(async () => {});
	c.tailLogs = vi.fn(async () => {});
	c.scanCerts = vi.fn();
	c.prune = vi.fn(async () => {
		calls.prune++;
	});
	return { c, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Collector.reconfigure', () => {
	it('re-arms a waiting probe timer to the new, shorter interval', async () => {
		const { c, calls } = collector();
		c.start();
		await vi.advanceTimersByTimeAsync(0); // first run of every job
		expect(calls.probes).toBe(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls.probes).toBe(1); // next run due at 60s

		c.reconfigure({ ...base, probeIntervalMs: 5_000 });
		expect(c.intervalOf('probes')).toBe(5_000);
		expect(c.status.probes.intervalMs).toBe(5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls.probes).toBe(2);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls.probes).toBe(3);
		c.stop();
	});

	it('re-arms the scrape timer and the upstream poll to a longer interval', async () => {
		const { c, calls } = collector();
		c.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.metrics).toBe(1);
		c.reconfigure({ ...base, scrapeIntervalMs: 120_000 });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls.metrics).toBe(1); // the old 30s timer is gone
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls.metrics).toBe(2);
		expect(c.status.metrics.intervalMs).toBe(120_000);
		expect(c.intervalOf('upstreams')).toBe(120_000);
		expect(c.pollUpstreams).toHaveBeenCalledTimes(2);
		c.stop();
	});

	it('lets a running job pick up the new interval when it schedules its next run', async () => {
		const { c } = collector();
		let release!: () => void;
		let runs = 0;
		c.probeAll = vi.fn(() => {
			runs++;
			return runs === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve();
		});
		c.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(runs).toBe(1);
		c.reconfigure({ ...base, probeIntervalMs: 2_000 }); // while the first run is still going
		release();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(runs).toBe(2);
		c.stop();
	});

	it('uses the new retention at the next prune and leaves environment-only fields alone', async () => {
		const db = openDb(':memory:');
		const c = new Collector(db, base);
		db.prepare(
			`INSERT INTO probes (site_id, target, kind, ts, ok) VALUES ('s', 't', 'site', ?, 1), ('s', 't', 'site', ?, 1)`
		).run(Date.now() - 20 * 86_400_000, Date.now() - 2 * 86_400_000);
		c.reconfigure({ ...base, retentionDays: 10, logPath: '/elsewhere', adminUrl: 'http://other:2019' });
		vi.useRealTimers(); // pruning pauses between batches
		await c.prune();
		expect(db.prepare('SELECT count(*) AS n FROM probes').get()).toEqual({ n: 1 });
		expect(c.status.logs.path).toBe('/nonexistent/access.log');
	});

	it('does nothing to timers before start or after stop', async () => {
		const { c, calls } = collector();
		c.reconfigure({ ...base, probeIntervalMs: 1_000 });
		expect(c.intervalOf('probes')).toBeUndefined();
		c.start();
		c.stop();
		c.reconfigure({ ...base, probeIntervalMs: 2_000 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls.probes).toBe(0);
	});
});
