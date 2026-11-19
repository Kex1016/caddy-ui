import type { CaddyStatus } from '$lib/api/config';
import type { PorkbunStatus } from '$lib/api/porkbun';
import type {
	DiagnosticCheck,
	DiagnosticState,
	DiagnosticsReport,
	PathCheck,
	StorageFacts
} from '$lib/settings/types';
import type { CollectorStatus, JobStatus } from '../collector/worker';
import type { SlowLoad } from '../timing';

/**
 * "Check everything" (docs/settings-and-perf-plan.md §3, Diagnostics): one report over what the UI depends on.
 * Pure over its inputs, which the Settings page's form action gathers: the admin API's answer (through
 * `adminFetch`, via the config service), the collector's job status, the path checks, Porkbun's `/ping`, the
 * storage facts and the slowest recent page loads (S0's Server-Timing log). Nothing here reads a large table.
 */

export type DiagnosticsInput = {
	now: number;
	tookMs: number;
	caddy: CaddyStatus | { error: string };
	collector: CollectorStatus;
	/** Seconds-precision intervals the jobs run at, to judge whether one is overdue. */
	intervals: { probes: number; metrics: number };
	paths: PathCheck[];
	porkbun: PorkbunStatus | { error: string };
	storage: StorageFacts;
	slow: readonly SlowLoad[];
	certs: { count: number; expiringSoon: number; expired: number; warnDays: number };
	/** Sites whose probing is switched off in Settings. */
	skipped: number;
};

const LOG_JOB_MS = 5_000;
const HOURLY = 3_600_000;
const STALE_LOG_MS = 24 * HOURLY;

const worst = (states: DiagnosticState[]): DiagnosticState =>
	states.includes('error')
		? 'error'
		: states.includes('warning')
			? 'warning'
			: states.every((s) => s === 'off') && states.length
				? 'off'
				: 'ok';

function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 90) return `${s} s ago`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} days ago`;
}

function bytes(n: number): string {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	if (n >= 1024) return `${Math.round(n / 1024)} KB`;
	return `${n} bytes`;
}

function admin(i: DiagnosticsInput): DiagnosticCheck {
	const base = { id: 'admin', label: 'Caddy admin API' };
	if ('error' in i.caddy && !('reachable' in i.caddy)) {
		return { ...base, state: 'error', message: `The check failed: ${i.caddy.error}` };
	}
	const c = i.caddy as CaddyStatus;
	if (!c.reachable) {
		return {
			...base,
			state: 'error',
			message: `Not reachable${c.error ? `: ${c.error}` : ''}. Nothing can be applied, and upstream health is unknown.`,
			fix: { href: '#connections', label: 'Connections' }
		};
	}
	const details: NonNullable<DiagnosticCheck['details']> = [];
	if (c.drift && c.drift.state !== 'in_sync') {
		details.push({
			label: 'Running config',
			state: 'warning',
			text: 'Differs from the Caddyfile on disk; the editor says how.'
		});
	}
	if (c.externalChange) {
		details.push({ label: 'Caddyfile', state: 'warning', text: 'Changed on disk outside the UI.' });
	}
	return {
		...base,
		state: c.error ? 'warning' : worst(details.map((d) => d.state)),
		message: `Reachable${c.version ? `, Caddy ${c.version}` : ''}.${c.error ? ` ${c.error}` : ''}`,
		...(details.length ? { details } : {})
	};
}

function metrics(i: DiagnosticsInput): DiagnosticCheck {
	const m = i.collector.metrics;
	const base = { id: 'metrics', label: 'Caddy metrics' };
	if (m.lastRun === null)
		return { ...base, state: 'warning', message: 'Not read yet; the first scrape is still due.' };
	if (m.error) {
		return {
			...base,
			state: 'warning',
			message: `Could not be read: ${m.error}. Turn metrics on to get traffic and latency charts.`,
			fix: { href: '#helpers', label: 'Caddy helpers' }
		};
	}
	if (!m.perHost) {
		return {
			...base,
			state: 'warning',
			message: 'On, but not per host, so traffic is not split by site.',
			fix: { href: '#helpers', label: 'Turn on per_host' }
		};
	}
	return {
		...base,
		state: 'ok',
		message: `On and per host; last read ${ago(i.now - (m.lastOk ?? m.lastRun))}.`
	};
}

function accessLog(i: DiagnosticsInput): DiagnosticCheck {
	const l = i.collector.logs;
	const base = { id: 'access-log', label: 'Access log' };
	if (l.error) return { ...base, state: 'warning', message: `Could not be read: ${l.error}` };
	if (!l.found) {
		return {
			...base,
			state: 'warning',
			message: `Not found at ${l.path}. Without it there are no status-code and top-path charts.`,
			fix: { href: '#helpers', label: 'Turn on the access log' }
		};
	}
	const behind =
		l.lagBytes > 0
			? ` The reader is ${bytes(l.lagBytes)} behind and catching up.`
			: ' The reader is up to date.';
	if (l.lastEntry === null) {
		return {
			...base,
			state: 'warning',
			message: `Found at ${l.path}, but no JSON access entry read yet.${behind}`
		};
	}
	const age = i.now - l.lastEntry;
	const excluded = l.excluded
		? ` ${l.excluded.toLocaleString('en-GB')} ${l.excluded === 1 ? 'request' : 'requests'} from excluded networks not counted since the UI started.`
		: '';
	return {
		...base,
		state: age > STALE_LOG_MS || l.lagBytes > 64 * 1024 * 1024 ? 'warning' : 'ok',
		message: `Last entry ${ago(age)}.${behind}${excluded}`
	};
}

function paths(i: DiagnosticsInput): DiagnosticCheck {
	const state = worst(i.paths.map((p) => p.state));
	return {
		id: 'paths',
		label: 'Files and directories',
		state,
		message:
			state === 'ok'
				? 'The Caddyfile, the access log, Caddy’s data and the UI’s data are where they should be.'
				: 'One or more paths need a look.',
		details: i.paths.map((p) => ({ label: p.key, state: p.state, text: `${p.path}: ${p.message}` })),
		...(state === 'ok' ? {} : { fix: { href: '#connections', label: 'Connections' } })
	};
}

function porkbun(i: DiagnosticsInput): DiagnosticCheck {
	const base = { id: 'porkbun', label: 'Porkbun' };
	const p = i.porkbun;
	if ('error' in p && !('state' in p))
		return { ...base, state: 'error', message: `The check failed: ${p.error}` };
	const s = p as PorkbunStatus;
	if (s.state === 'off')
		return { ...base, state: 'off', message: 'Not set up: the keys are not set, so Domains is off.' };
	if (s.state === 'misconfigured') return { ...base, state: 'error', message: `${s.missing} is not set.` };
	if (s.state === 'error') {
		return {
			...base,
			state: 'error',
			message: `Ping failed: ${s.error?.message ?? 'Porkbun did not accept the keys.'}`
		};
	}
	const scopes = s.scopes.length
		? `The key may use ${s.scopes.join(', ')}.`
		: 'The key has no API scopes listed.';
	return {
		...base,
		state: 'ok',
		message: `Ping answered${s.account ? ` for ${s.account}` : ''}. ${scopes}${s.sandbox ? ' Sandbox key.' : ''}${s.readonly ? ' Read-only here.' : ''}`
	};
}

function jobs(i: DiagnosticsInput): DiagnosticCheck {
	const c = i.collector;
	const judge = (
		name: string,
		j: JobStatus,
		every: number
	): { label: string; state: DiagnosticState; text: string } => {
		if (j.error) return { label: name, state: 'error', text: j.error };
		if (j.lastRun === null) return { label: name, state: 'warning', text: 'Not run yet.' };
		const since = i.now - (j.lastOk ?? j.lastRun);
		// Overdue: three runs missed, plus a minute for a slow probe cycle.
		if (since > every * 3 + 60_000)
			return { label: name, state: 'warning', text: `Last worked ${ago(since)}.` };
		return { label: name, state: 'ok', text: `Last worked ${ago(since)}.` };
	};
	const details = [
		judge('Caddyfile', c.caddyfile, i.intervals.probes),
		judge('Probes', c.probes, i.intervals.probes),
		judge('Upstream health', c.upstreams, i.intervals.metrics),
		judge('Metrics', c.metrics, i.intervals.metrics),
		judge('Access log', c.logs, LOG_JOB_MS),
		judge('Certificates', c.certs, HOURLY)
	];
	// Metrics and the access log are optional and have their own checks above.
	const counted = details.filter((d) => d.label !== 'Metrics' && d.label !== 'Access log');
	const state = worst(counted.map((d) => d.state));
	return {
		id: 'jobs',
		label: 'Collector',
		state,
		message:
			(state === 'ok' ? 'Every job ran on time.' : 'A job is failing or late.') +
			(i.skipped
				? ` ${i.skipped} ${i.skipped === 1 ? 'site is' : 'sites are'} not probed (per-site options).`
				: ''),
		details
	};
}

function certs(i: DiagnosticsInput): DiagnosticCheck {
	const c = i.certs;
	const base = { id: 'certs', label: 'Certificates' };
	if (c.count === 0) return { ...base, state: 'off', message: 'None read from Caddy’s data directory.' };
	if (c.expired > 0) return { ...base, state: 'error', message: `${c.expired} of ${c.count} expired.` };
	if (c.expiringSoon > 0) {
		return {
			...base,
			state: 'warning',
			message: `${c.expiringSoon} of ${c.count} expire within ${c.warnDays} days. Caddy renews them 30 days before expiry, so this means a renewal is failing.`
		};
	}
	return { ...base, state: 'ok', message: `${c.count} read; none expire within ${c.warnDays} days.` };
}

function storage(i: DiagnosticsInput): DiagnosticCheck {
	const s = i.storage;
	const size = s.fileBytes + s.walBytes;
	const base = { id: 'storage', label: 'Database' };
	if (s.volumeFreeBytes === null)
		return { ...base, state: 'ok', message: `${bytes(size)}; free space unknown.` };
	const low =
		s.volumeFreeBytes < 512 * 1024 * 1024 ||
		(s.volumeTotalBytes !== null && s.volumeFreeBytes < s.volumeTotalBytes * 0.05);
	return {
		...base,
		state: low ? 'warning' : 'ok',
		message: `${bytes(size)}, with ${bytes(s.volumeFreeBytes)} free on the volume.${low ? ' Space is running low: lower retention or free space.' : ''}`,
		...(low ? { fix: { href: '#storage', label: 'Data and storage' } } : {})
	};
}

function slow(i: DiagnosticsInput): DiagnosticCheck {
	const recent = i.slow.filter((s) => i.now - s.at < HOURLY);
	const base = { id: 'slow', label: 'Page loads' };
	if (i.slow.length === 0)
		return { ...base, state: 'ok', message: 'No page took over 500 ms since the UI started.' };
	const top = [...i.slow].sort((a, b) => b.totalMs - a.totalMs).slice(0, 5);
	return {
		...base,
		state: recent.length > 0 ? 'warning' : 'ok',
		message:
			recent.length > 0
				? `${recent.length} ${recent.length === 1 ? 'load' : 'loads'} over 500 ms in the last hour.`
				: 'None over 500 ms in the last hour; the slowest since start are below.',
		details: top.map((s) => {
			const steps = [...s.steps]
				.filter((x) => x.dur !== undefined)
				.sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
				.slice(0, 3)
				.map((x) => `${x.name} ${Math.round(x.dur ?? 0)} ms`)
				.join(', ');
			return {
				label: s.path,
				state: i.now - s.at < HOURLY ? ('warning' as const) : ('ok' as const),
				text: `${Math.round(s.totalMs)} ms, ${ago(i.now - s.at)}${steps ? ` (${steps})` : ''}`
			};
		})
	};
}

export function diagnose(i: DiagnosticsInput): DiagnosticsReport {
	return {
		at: i.now,
		tookMs: i.tookMs,
		checks: [admin(i), metrics(i), accessLog(i), paths(i), porkbun(i), jobs(i), certs(i), storage(i), slow(i)]
	};
}
