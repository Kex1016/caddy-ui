import type { Db } from '../db';
import { parseAddress } from './sites';
import type { State } from './store';

/** Read side of the collector: shapes rows into what `/api/sites*` and `/api/overview` return. */

export const RANGES = {
	'1h': { spanMs: 3_600_000, stepMs: 60_000 },
	'24h': { spanMs: 86_400_000, stepMs: 300_000 },
	'7d': { spanMs: 7 * 86_400_000, stepMs: 3_600_000 },
	'30d': { spanMs: 30 * 86_400_000, stepMs: 6 * 3_600_000 }
} as const;
export type Range = keyof typeof RANGES;

export function parseRange(v: string | null): Range | undefined {
	if (v === null || v === '') return '24h';
	return v in RANGES ? (v as Range) : undefined;
}

/** [bucket start ms, value]. null means no data for that bucket (the source was off or the scrape failed). */
export type Point = [number, number | null];
export type Source = 'metrics' | 'logs' | 'probes';
export type Series = { source: Source | null; points: Point[] };

export type Window = { from: number; to: number; stepMs: number; buckets: number[] };

export function window(range: Range, now: number): Window {
	const { spanMs, stepMs } = RANGES[range];
	const to = Math.floor(now / stepMs) * stepMs + stepMs;
	const from = to - spanMs;
	const buckets: number[] = [];
	for (let t = from; t < to; t += stepMs) buckets.push(t);
	return { from, to, stepMs, buckets };
}

const bucketOf = (w: Window, ts: number) => Math.floor((ts - w.from) / w.stepMs);

type Agg = 'sum' | 'max' | 'weighted' | 'last';

function fill(
	w: Window,
	rows: { ts: number; v: number; weight?: number }[],
	agg: Agg,
	covered?: Set<number>
): Point[] {
	const acc = w.buckets.map(() => ({ v: 0, w: 0, n: 0 }));
	for (const r of rows) {
		const i = bucketOf(w, r.ts);
		const a = acc[i];
		if (!a) continue;
		if (agg === 'sum') a.v += r.v;
		else if (agg === 'max') a.v = a.n === 0 ? r.v : Math.max(a.v, r.v);
		else if (agg === 'last') a.v = r.v;
		else {
			const weight = r.weight ?? 1;
			a.v += r.v * weight;
			a.w += weight;
		}
		a.n++;
	}
	return w.buckets.map((t, i) => {
		const a = acc[i] as { v: number; w: number; n: number };
		if (a.n === 0) return [t, covered?.has(i) && agg === 'sum' ? 0 : null];
		if (agg === 'weighted') return [t, a.w > 0 ? Math.round((a.v / a.w) * 10) / 10 : null];
		return [t, a.v];
	});
}

const empty = (w: Window): Series => ({ source: null, points: w.buckets.map((t) => [t, null]) });

function metricRows(db: Db, name: string, site: string, w: Window) {
	return db
		.prepare(
			`SELECT ts, value AS v FROM metric_samples WHERE name = ? AND labels_json = ? AND ts >= ? AND ts < ? ORDER BY ts`
		)
		.all(name, JSON.stringify({ site }), w.from, w.to) as { ts: number; v: number }[];
}

/** Buckets in which the server-wide scrape row exists, i.e. metrics were being collected. */
function metricCoverage(db: Db, w: Window): Set<number> {
	return new Set(metricRows(db, 'requests', '*', w).map((r) => bucketOf(w, r.ts)));
}

function logCoverage(db: Db, w: Window): Set<number> {
	const rows = db
		.prepare(`SELECT minute FROM log_minutes WHERE site_id = '*' AND minute >= ? AND minute < ?`)
		.all(w.from, w.to) as { minute: number }[];
	return new Set(rows.map((r) => bucketOf(w, r.minute)));
}

export type TrafficSeries = {
	requests: Series;
	errors4xx: Series;
	errors5xx: Series;
	latencyP50: Series;
	latencyP95: Series;
	bytesOut: Series;
	inFlight: Series;
};

/**
 * Traffic series for one site ('*' for the whole server). The access log is exact, so it wins when it has
 * data in the window; otherwise Caddy's metrics are used. A minute with no row is zero traffic where the
 * source was running, and a gap (null) where it was not.
 */
export function traffic(db: Db, site: string, w: Window): TrafficSeries {
	const logCov = logCoverage(db, w);
	const inFlight = (() => {
		const rows = metricRows(db, 'in_flight', site, w);
		return rows.length ? { source: 'metrics' as const, points: fill(w, rows, 'max') } : empty(w);
	})();
	if (logCov.size > 0) {
		const rows = db
			.prepare(
				`SELECT minute AS ts, requests, errors_4xx, errors_5xx, bytes_out, p50_ms, p95_ms FROM log_minutes
				 WHERE site_id = ? AND minute >= ? AND minute < ?`
			)
			.all(site, w.from, w.to) as {
			ts: number;
			requests: number;
			errors_4xx: number;
			errors_5xx: number;
			bytes_out: number;
			p50_ms: number | null;
			p95_ms: number | null;
		}[];
		const s = (pick: (r: (typeof rows)[number]) => number): Series => ({
			source: 'logs',
			points: fill(
				w,
				rows.map((r) => ({ ts: r.ts, v: pick(r) })),
				'sum',
				logCov
			)
		});
		const lat = (pick: (r: (typeof rows)[number]) => number | null): Series => ({
			source: 'logs',
			points: fill(
				w,
				rows
					.filter((r) => pick(r) !== null)
					.map((r) => ({ ts: r.ts, v: pick(r) as number, weight: r.requests })),
				'weighted'
			)
		});
		return {
			requests: s((r) => r.requests),
			errors4xx: s((r) => r.errors_4xx),
			errors5xx: s((r) => r.errors_5xx),
			bytesOut: s((r) => r.bytes_out),
			latencyP50: lat((r) => r.p50_ms),
			latencyP95: lat((r) => r.p95_ms),
			inFlight
		};
	}
	const cov = metricCoverage(db, w);
	if (cov.size === 0) {
		return {
			requests: empty(w),
			errors4xx: empty(w),
			errors5xx: empty(w),
			bytesOut: empty(w),
			latencyP50: empty(w),
			latencyP95: empty(w),
			inFlight
		};
	}
	const counter = (name: string): Series => ({
		source: 'metrics',
		points: fill(w, metricRows(db, name, site, w), 'sum', cov)
	});
	const reqByMinute = new Map(metricRows(db, 'requests', site, w).map((r) => [r.ts, r.v]));
	const lat = (name: string): Series => ({
		source: 'metrics',
		points: fill(
			w,
			metricRows(db, name, site, w).map((r) => ({ ...r, weight: reqByMinute.get(r.ts) ?? 1 })),
			'weighted'
		)
	});
	return {
		requests: counter('requests'),
		errors4xx: counter('errors_4xx'),
		errors5xx: counter('errors_5xx'),
		bytesOut: counter('bytes_out'),
		latencyP50: lat('latency_p50_ms'),
		latencyP95: lat('latency_p95_ms'),
		inFlight
	};
}

export function total(s: Series): number | null {
	let any = false;
	let n = 0;
	for (const [, v] of s.points) {
		if (v === null) continue;
		any = true;
		n += v;
	}
	return any ? n : null;
}

/** Request-weighted mean of a latency series over the window. */
export function weightedMean(lat: Series, requests: Series): number | null {
	let sum = 0;
	let weight = 0;
	lat.points.forEach(([, v], i) => {
		const r = requests.points[i]?.[1] ?? 0;
		if (v === null || !r) return;
		sum += v * r;
		weight += r;
	});
	return weight > 0 ? Math.round((sum / weight) * 10) / 10 : null;
}

export function topLists(
	db: Db,
	site: string,
	w: Window
): { paths: [string, number][]; ips: [string, number][] } | null {
	const rows = db
		.prepare(
			`SELECT top_paths_json, top_ips_json FROM log_minutes WHERE site_id = ? AND minute >= ? AND minute < ?`
		)
		.all(site, w.from, w.to) as { top_paths_json: string; top_ips_json: string }[];
	if (rows.length === 0) return null;
	const sum = (key: 'top_paths_json' | 'top_ips_json') => {
		const m = new Map<string, number>();
		for (const r of rows)
			for (const [k, v] of JSON.parse(r[key]) as [string, number][]) m.set(k, (m.get(k) ?? 0) + v);
		return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
	};
	return { paths: sum('top_paths_json'), ips: sum('top_ips_json') };
}

export type StateSpan = { from: number; to: number; state: State };

/** The site's (or one upstream's) state over the window, as contiguous spans. */
export function stateSpans(db: Db, siteId: string, target: string, from: number, to: number): StateSpan[] {
	const before = db
		.prepare(
			`SELECT "to" AS state FROM state_changes WHERE site_id = ? AND target = ? AND ts < ? ORDER BY ts DESC LIMIT 1`
		)
		.get(siteId, target, from) as { state: State } | undefined;
	const changes = db
		.prepare(
			`SELECT ts, "to" AS state FROM state_changes WHERE site_id = ? AND target = ? AND ts >= ? AND ts < ? ORDER BY ts`
		)
		.all(siteId, target, from, to) as { ts: number; state: State }[];
	const spans: StateSpan[] = [];
	let cur: State = before?.state ?? 'unknown';
	let start = from;
	for (const c of changes) {
		if (c.ts > start) spans.push({ from: start, to: c.ts, state: cur });
		cur = c.state;
		start = c.ts;
	}
	if (to > start) spans.push({ from: start, to, state: cur });
	return spans;
}

/** Share of known time spent up, 0–1, or null when nothing is known about the window. */
export function uptimeRatio(spans: StateSpan[]): number | null {
	let up = 0;
	let known = 0;
	for (const s of spans) {
		if (s.state === 'unknown') continue;
		known += s.to - s.from;
		if (s.state === 'up') up += s.to - s.from;
	}
	return known > 0 ? Math.round((up / known) * 10000) / 10000 : null;
}

export type StripCell = { t: number; state: State | 'mixed'; upRatio: number | null };

/** One cell per bucket for an uptime strip: up, down, mixed (both in one bucket) or unknown. */
export function uptimeStrip(spans: StateSpan[], w: Window, until: number): StripCell[] {
	return w.buckets.map((t) => {
		const end = Math.min(t + w.stepMs, until);
		let up = 0;
		let down = 0;
		for (const s of spans) {
			const a = Math.max(s.from, t);
			const b = Math.min(s.to, end);
			if (b <= a) continue;
			if (s.state === 'up') up += b - a;
			else if (s.state === 'down') down += b - a;
		}
		if (up + down === 0) return { t, state: 'unknown', upRatio: null };
		const upRatio = Math.round((up / (up + down)) * 1000) / 1000;
		return { t, state: down === 0 ? 'up' : up === 0 ? 'down' : 'mixed', upRatio };
	});
}

export function probeLatency(db: Db, siteId: string, w: Window): Series {
	const rows = db
		.prepare(
			`SELECT ts, latency_ms AS v FROM probes WHERE site_id = ? AND kind = 'site' AND ok = 1 AND latency_ms IS NOT NULL
			 AND ts >= ? AND ts < ?`
		)
		.all(siteId, w.from, w.to) as { ts: number; v: number }[];
	if (rows.length === 0) return empty(w);
	return { source: 'probes', points: fill(w, rows, 'weighted') };
}

export type CertRow = { host: string; notAfter: number; issuer: string | null; daysLeft: number };

export function allCerts(db: Db, now: number): CertRow[] {
	const rows = db.prepare(`SELECT host, not_after, issuer FROM certs ORDER BY not_after`).all() as {
		host: string;
		not_after: number;
		issuer: string | null;
	}[];
	return rows.map((r) => ({
		host: r.host,
		notAfter: r.not_after,
		issuer: r.issuer,
		daysLeft: Math.floor((r.not_after - now) / 86_400_000)
	}));
}

/** The certificate that serves a site: the one expiring soonest among its hosts, exact names before wildcards. */
export function certFor(addresses: string[], certs: CertRow[]): CertRow | null {
	let best: CertRow | null = null;
	for (const raw of addresses) {
		const { host } = parseAddress(raw);
		if (!host) continue;
		const parent = host.includes('.') ? `*${host.slice(host.indexOf('.'))}` : undefined;
		const c =
			certs.find((x) => x.host === host) ?? (parent ? certs.find((x) => x.host === parent) : undefined);
		if (c && (!best || c.notAfter < best.notAfter)) best = c;
	}
	return best;
}

export type LatestProbe = {
	target: string;
	ts: number;
	ok: boolean;
	latencyMs: number | null;
	status: number | null;
	error: string | null;
};

/** The newest probe per (site, target). */
export function latestProbes(db: Db): Map<string, LatestProbe> {
	const rows = db
		.prepare(
			`SELECT p.site_id, p.target, p.ts, p.ok, p.latency_ms, p.status, p.error FROM probes p
			 JOIN (SELECT site_id, target, MAX(ts) AS ts FROM probes GROUP BY site_id, target) m
			   ON m.site_id = p.site_id AND m.target = p.target AND m.ts = p.ts`
		)
		.all() as {
		site_id: string;
		target: string;
		ts: number;
		ok: number;
		latency_ms: number | null;
		status: number | null;
		error: string | null;
	}[];
	return new Map(
		rows.map((r) => [
			`${r.site_id}|${r.target}`,
			{
				target: r.target,
				ts: r.ts,
				ok: r.ok === 1,
				latencyMs: r.latency_ms,
				status: r.status,
				error: r.error
			}
		])
	);
}

export function latestGauge(
	db: Db,
	name: string,
	labels: Record<string, string>
): { ts: number; value: number } | null {
	const row = db
		.prepare(
			`SELECT ts, value FROM metric_samples WHERE name = ? AND labels_json = ? ORDER BY ts DESC LIMIT 1`
		)
		.get(name, JSON.stringify(labels)) as { ts: number; value: number } | undefined;
	return row ?? null;
}

export function gaugeSeries(db: Db, name: string, w: Window): Series {
	const rows = metricRows(db, name, '*', w);
	return rows.length ? { source: 'metrics', points: fill(w, rows, 'max') } : empty(w);
}

/** Requests per site over the window, busiest first, from whichever source `traffic` would use. */
export function requestsBySite(db: Db, w: Window): { siteId: string; requests: number; source: Source }[] {
	const fromLogs = db
		.prepare(
			`SELECT site_id, SUM(requests) AS n FROM log_minutes WHERE site_id NOT IN ('*', '') AND minute >= ? AND minute < ?
			 GROUP BY site_id ORDER BY n DESC`
		)
		.all(w.from, w.to) as { site_id: string; n: number }[];
	if (logCoverage(db, w).size > 0)
		return fromLogs.map((r) => ({ siteId: r.site_id, requests: r.n, source: 'logs' }));
	const fromMetrics = db
		.prepare(
			`SELECT json_extract(labels_json, '$.site') AS site_id, SUM(value) AS n FROM metric_samples
			 WHERE name = 'requests' AND labels_json != '{"site":"*"}' AND ts >= ? AND ts < ? GROUP BY labels_json ORDER BY n DESC`
		)
		.all(w.from, w.to) as { site_id: string; n: number }[];
	return fromMetrics.map((r) => ({ siteId: r.site_id, requests: r.n, source: 'metrics' }));
}
