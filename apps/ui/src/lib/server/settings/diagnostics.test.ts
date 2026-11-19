import { describe, expect, it } from 'vitest';
import type { CaddyStatus } from '$lib/api/config';
import type { CollectorStatus } from '../collector/worker';
import { diagnose, type DiagnosticsInput } from './diagnostics';

const NOW = Date.UTC(2026, 10, 19, 12);
const ok = (ms = 1_000) => ({ lastRun: NOW - ms, lastOk: NOW - ms, error: null });

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
	const collector: CollectorStatus = {
		startedAt: NOW - 3_600_000,
		caddyfile: { ...ok(), sites: 3 },
		probes: { ...ok(), intervalMs: 30_000 },
		metrics: { ...ok(), intervalMs: 15_000, perHost: true },
		logs: {
			...ok(),
			path: '/var/log/caddy/access.log',
			found: true,
			lastEntry: NOW - 5_000,
			lagBytes: 0,
			excluded: 0
		},
		certs: { ...ok(), count: 2 },
		upstreams: ok()
	};
	const caddy: CaddyStatus = {
		checkedAt: NOW,
		reachable: true,
		error: null,
		version: 'v2.10.2',
		startedAt: null,
		lastReload: null,
		configHash: 'x',
		file: { path: '/etc/caddy/Caddyfile', exists: true, hash: 'y' },
		drift: { state: 'in_sync' },
		externalChange: null
	};
	return {
		now: NOW,
		tookMs: 12,
		caddy,
		collector,
		intervals: { probes: 30_000, metrics: 15_000 },
		paths: [
			{ key: 'CADDYFILE_PATH', path: '/etc/caddy/Caddyfile', state: 'ok', message: 'Readable and writable.' }
		],
		porkbun: { state: 'off', sandbox: false, readonly: false, scopes: [] },
		storage: {
			at: NOW,
			fileBytes: 10 * 1024 ** 2,
			walBytes: 0,
			freeInFileBytes: 0,
			volumeFreeBytes: 50 * 1024 ** 3,
			volumeTotalBytes: 100 * 1024 ** 3,
			oldest: {}
		},
		slow: [],
		certs: { count: 2, expired: 0, expiringSoon: 0, warnDays: 14 },
		skipped: 0,
		...over
	};
}

const state = (r: ReturnType<typeof diagnose>, id: string) => r.checks.find((c) => c.id === id)?.state;

describe('diagnose', () => {
	it('is all OK on a healthy setup, with Porkbun off', () => {
		const r = diagnose(input());
		expect(r.checks.map((c) => c.id)).toEqual([
			'admin',
			'metrics',
			'access-log',
			'paths',
			'porkbun',
			'jobs',
			'certs',
			'storage',
			'slow'
		]);
		expect(r.checks.filter((c) => c.state !== 'ok').map((c) => c.id)).toEqual(['porkbun']);
		expect(state(r, 'porkbun')).toBe('off');
		expect(r.checks[0]?.message).toContain('Caddy v2.10.2');
	});

	it('flags an unreachable admin API, metrics without per_host and a missing log, with fixes', () => {
		const i = input();
		i.caddy = { ...(i.caddy as CaddyStatus), reachable: false, error: 'connect ECONNREFUSED' };
		i.collector.metrics.perHost = false;
		i.collector.logs.found = false;
		const r = diagnose(i);
		expect(state(r, 'admin')).toBe('error');
		expect(state(r, 'metrics')).toBe('warning');
		expect(r.checks.find((c) => c.id === 'metrics')?.fix?.href).toBe('#helpers');
		expect(state(r, 'access-log')).toBe('warning');
	});

	it('says how many requests from excluded networks were left out', () => {
		const i = input();
		expect(diagnose(i).checks.find((c) => c.id === 'access-log')?.message).not.toContain('excluded');
		i.collector.logs.excluded = 1234;
		const log = diagnose(i).checks.find((c) => c.id === 'access-log')!;
		expect(log.state).toBe('ok');
		expect(log.message).toContain('1,234 requests from excluded networks not counted');
	});

	it('says a job is late or failing', () => {
		const i = input();
		i.collector.probes = { ...i.collector.probes, lastOk: NOW - 10 * 60_000, lastRun: NOW - 10 * 60_000 };
		i.collector.certs.error = 'EACCES';
		const r = diagnose(i);
		const jobs = r.checks.find((c) => c.id === 'jobs')!;
		expect(jobs.state).toBe('error');
		expect(jobs.details?.find((d) => d.label === 'Probes')?.state).toBe('warning');
		expect(jobs.details?.find((d) => d.label === 'Certificates')?.text).toBe('EACCES');
	});

	it('lists the slowest page loads, and certificates near expiry', () => {
		const r = diagnose(
			input({
				slow: [
					{ at: NOW - 60_000, path: '/', totalMs: 900, steps: [{ name: 'traffic', dur: 700 }] },
					{ at: NOW - 7_200_000, path: '/sites', totalMs: 1500, steps: [] }
				],
				certs: { count: 3, expired: 0, expiringSoon: 1, warnDays: 21 }
			})
		);
		const slow = r.checks.find((c) => c.id === 'slow')!;
		expect(slow.state).toBe('warning');
		expect(slow.details?.map((d) => d.label)).toEqual(['/sites', '/']);
		expect(slow.details?.[1]?.text).toContain('traffic 700 ms');
		expect(state(r, 'certs')).toBe('warning');
		expect(r.checks.find((c) => c.id === 'certs')?.message).toContain('21 days');
	});

	it('warns when the volume is nearly full, and when Porkbun refuses the keys', () => {
		const i = input({
			porkbun: {
				state: 'error',
				sandbox: false,
				readonly: false,
				scopes: [],
				error: { code: 'X', message: 'Invalid API key', retryable: false }
			}
		});
		i.storage.volumeFreeBytes = 100 * 1024 ** 2;
		const r = diagnose(i);
		expect(state(r, 'storage')).toBe('warning');
		expect(state(r, 'porkbun')).toBe('error');
		expect(r.checks.find((c) => c.id === 'porkbun')?.message).toContain('Invalid API key');
	});
});
