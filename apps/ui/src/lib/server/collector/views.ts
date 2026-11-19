import type { Db } from '../db';
import type { Timing } from '../timing';
import {
	allCerts,
	certFor,
	gaugeSeries,
	latestGauge,
	latestProbes,
	probeLatency,
	requestsBySite,
	siteSpans,
	stateSpans,
	topLists,
	total,
	traffic,
	uptimeRatio,
	uptimeStrip,
	weightedMean,
	window,
	type CertRow,
	type LatestProbe,
	type Range
} from './queries';
import { probeTarget } from './sites';
import type { State } from './store';
import type { Collector, CollectorStatus } from './worker';

/**
 * The read side: shapes what the collector stored into the `/api/sites*` and `/api/overview` payloads
 * (PLAN.md §3.2). The pages and those routes read them through the snapshot (snapshot.ts), not from here.
 */

/** Runs a step under `t` when there is one. */
function step<T>(t: Timing | undefined, name: string, fn: () => T): T {
	return t ? t.measure(name, fn) : fn();
}

export type SourceSummary = {
	caddyfile: { ok: boolean; error: string | null; sites: number };
	probes: { ok: boolean; lastRun: number | null; intervalMs: number };
	metrics: { ok: boolean; lastRun: number | null; error: string | null; perHost: boolean };
	logs: { ok: boolean; found: boolean; path: string; lastEntry: number | null; error: string | null };
	certs: { ok: boolean; count: number; error: string | null };
	admin?: { ok: boolean };
};

export function sourceSummary(c: Collector): SourceSummary {
	return sources(c.status);
}

function sources(s: CollectorStatus): SourceSummary {
	return {
		caddyfile: {
			ok: s.caddyfile.error === null && s.caddyfile.lastOk !== null,
			error: s.caddyfile.error,
			sites: s.caddyfile.sites
		},
		probes: { ok: s.probes.lastOk !== null, lastRun: s.probes.lastOk, intervalMs: s.probes.intervalMs },
		metrics: {
			ok: s.metrics.error === null && s.metrics.lastOk !== null,
			lastRun: s.metrics.lastOk,
			error: s.metrics.error,
			perHost: s.metrics.perHost
		},
		logs: {
			ok: s.logs.found && s.logs.error === null,
			found: s.logs.found,
			path: s.logs.path,
			lastEntry: s.logs.lastEntry,
			error: s.logs.error
		},
		certs: {
			ok: s.certs.error === null && s.certs.lastOk !== null,
			count: s.certs.count,
			error: s.certs.error
		}
	};
}

export type ProbeView = Omit<LatestProbe, 'target'> & { target: string };

export type UpstreamView = {
	address: string;
	via: string;
	status: State;
	since: number | null;
	probe: ProbeView | null;
	/** From Caddy's passive health checks; null when the admin API could not be reached. */
	activeRequests: number | null;
	fails: number | null;
};

export type SiteView = {
	id: string;
	addresses: string[];
	label: string;
	line: number;
	status: State;
	since: number | null;
	probe: ProbeView | null;
	upstreams: UpstreamView[];
	cert: CertRow | null;
	uptime24h: number | null;
};

export type SitesPayload = { asOf: number; sites: SiteView[]; sources: SourceSummary };

/**
 * Every site with its status, latest probes, upstreams and certificate. Reads states from the collector's
 * memory, the latest probes from `probe_latest`, the upstreams' passive health from the collector's last poll,
 * and the 24 h uptime of all sites in one query, so its cost does not grow with the age of the database.
 */
export function sitesPayload(c: Collector, db: Db, now = Date.now(), t?: Timing): SitesPayload {
	if (c.status.caddyfile.lastRun === null) c.refreshSites();
	const states = step(t, 'states', () => c.currentStates);
	const probes = step(t, 'latestProbes', () => latestProbes(db));
	const certs = step(t, 'certs', () => allCerts(db, now));
	const live = step(t, 'live', () => c.live.data);
	const spans = step(t, 'spans', () =>
		siteSpans(
			db,
			c.sites.map((s) => s.id),
			now - 86_400_000,
			now
		)
	);
	const sites = c.sites.map((s): SiteView => {
		const st = states.get(`${s.id}|`);
		const target = probeTarget(s.addresses, c.connectHost);
		const probe = target ? (probes.get(`${s.id}|${target.url}`) ?? null) : null;
		return {
			id: s.id,
			addresses: s.addresses,
			label: s.addresses[0] ?? s.id,
			line: s.line,
			status: st?.state ?? 'unknown',
			since: st?.since ?? null,
			probe,
			upstreams: s.upstreams.map((u) => {
				const us = states.get(`${s.id}|${u.address}`);
				const lv = live?.get(u.address) ?? live?.get(u.address.replace(/^[a-z0-9]+:\/\//, ''));
				return {
					address: u.address,
					via: u.via,
					status: us?.state ?? 'unknown',
					since: us?.since ?? null,
					probe: probes.get(`${s.id}|${u.address}`) ?? null,
					activeRequests: live ? (lv?.num_requests ?? 0) : null,
					fails: live ? (lv?.fails ?? 0) : null
				};
			}),
			cert: certFor(s.addresses, certs),
			uptime24h: uptimeRatio(spans.get(s.id) ?? [])
		};
	});
	return { asOf: now, sites, sources: { ...sources(c.status), admin: { ok: live !== null } } };
}

export function siteStats(c: Collector, db: Db, siteId: string, range: Range, now = Date.now()) {
	if (c.status.caddyfile.lastRun === null) c.refreshSites();
	const site = c.sites.find((s) => s.id === siteId);
	const known = site
		? { id: site.id, addresses: site.addresses, removedAt: null as number | null }
		: (() => {
				const row = db
					.prepare(`SELECT id, addresses_json, removed_at FROM sites WHERE id = ?`)
					.get(siteId) as { id: string; addresses_json: string; removed_at: number | null } | undefined;
				return row
					? { id: row.id, addresses: JSON.parse(row.addresses_json) as string[], removedAt: row.removed_at }
					: undefined;
			})();
	if (!known) return undefined;
	const w = window(range, now);
	const t = traffic(db, siteId, w);
	const spans = stateSpans(db, siteId, '', w.from, Math.min(w.to, now));
	const upstreams = (site?.upstreams ?? []).map((u) => {
		const us = stateSpans(db, siteId, u.address, w.from, Math.min(w.to, now));
		return { address: u.address, uptime: uptimeRatio(us), strip: uptimeStrip(us, w, now) };
	});
	return {
		asOf: now,
		site: known,
		range,
		from: w.from,
		to: w.to,
		stepMs: w.stepMs,
		totals: {
			requests: total(t.requests),
			errors4xx: total(t.errors4xx),
			errors5xx: total(t.errors5xx),
			bytesOut: total(t.bytesOut),
			latencyP50: weightedMean(t.latencyP50, t.requests),
			latencyP95: weightedMean(t.latencyP95, t.requests)
		},
		series: { ...t, probeLatency: probeLatency(db, siteId, w) },
		uptime: { ratio: uptimeRatio(spans), strip: uptimeStrip(spans, w, now) },
		upstreams,
		top: topLists(db, siteId, w),
		sources: sources(c.status)
	};
}

const CERT_WARN_DAYS = 14;

/** Overview, part 1: what is up right now and the certificates. Cheap; the page shows it at once. */
export function overviewStatus(c: Collector, db: Db, now = Date.now(), t?: Timing) {
	if (c.status.caddyfile.lastRun === null) c.refreshSites();
	const states = step(t, 'states', () => c.currentStates);
	const counts = { up: 0, down: 0, unknown: 0, total: c.sites.length };
	const ups = { up: 0, down: 0, unknown: 0 };
	const seenUpstream = new Set<string>();
	for (const s of c.sites) {
		counts[states.get(`${s.id}|`)?.state ?? 'unknown']++;
		for (const u of s.upstreams) {
			if (seenUpstream.has(u.address)) continue;
			seenUpstream.add(u.address);
			ups[states.get(`${s.id}|${u.address}`)?.state ?? 'unknown']++;
		}
	}
	const start = step(t, 'gauges', () => latestGauge(db, 'process_start_time_seconds', { site: '*' }));
	const certs = step(t, 'certs', () => allCerts(db, now));
	return {
		asOf: now,
		tiles: {
			sites: counts,
			upstreams: ups,
			caddyStartedAt: start
				? { value: Math.round(start.value * 1000), source: 'metrics' as const }
				: { value: null, source: null },
			certs: {
				count: certs.length,
				soonest: certs[0] ?? null,
				expiringSoon: certs.filter((x) => x.daysLeft < CERT_WARN_DAYS).length,
				warnDays: CERT_WARN_DAYS
			}
		},
		certs,
		sources: sources(c.status)
	};
}

/** Overview, part 2: the traffic tiles and every chart over the range. */
export function overviewTraffic(db: Db, range: Range, now = Date.now(), t?: Timing) {
	const w = window(range, now);
	const tr = step(t, 'traffic', () => traffic(db, '*', w));
	const requests = total(tr.requests);
	const errors5xx = total(tr.errors5xx);
	const process = step(t, 'process', () => ({
		memory: gaugeSeries(db, 'process_resident_memory_bytes', w),
		goroutines: gaugeSeries(db, 'go_goroutines', w)
	}));
	return {
		asOf: now,
		range,
		from: w.from,
		to: w.to,
		stepMs: w.stepMs,
		tiles: {
			requests: { value: requests, source: tr.requests.source },
			errorRate: {
				value:
					requests && errors5xx !== null
						? Math.round((errors5xx / requests) * 10000) / 10000
						: requests === 0
							? 0
							: null,
				source: tr.errors5xx.source
			},
			latencyP95: { value: weightedMean(tr.latencyP95, tr.requests), source: tr.latencyP95.source }
		},
		series: { ...tr, ...process }
	};
}

/** Overview, part 3: the busiest sites, paths and client IPs over the range. */
export function overviewTop(c: Collector, db: Db, range: Range, now = Date.now(), t?: Timing) {
	const w = window(range, now);
	const siteNames = new Map(c.sites.map((s) => [s.id, s.addresses[0] ?? s.id]));
	return {
		asOf: now,
		range,
		topSites: step(t, 'topSites', () => requestsBySite(db, w))
			.slice(0, 10)
			.map((r) => ({ ...r, label: siteNames.get(r.siteId) ?? r.siteId })),
		top: step(t, 'top', () => topLists(db, '*', w))
	};
}

export type OverviewStatus = ReturnType<typeof overviewStatus>;
export type OverviewTraffic = ReturnType<typeof overviewTraffic>;
export type OverviewTop = ReturnType<typeof overviewTop>;

/** The `/api/overview` payload (PLAN.md §3.2), put together from the three parts. */
export function joinOverview(status: OverviewStatus, tr: OverviewTraffic, top: OverviewTop) {
	return {
		asOf: status.asOf,
		range: tr.range,
		from: tr.from,
		to: tr.to,
		stepMs: tr.stepMs,
		tiles: {
			sites: status.tiles.sites,
			upstreams: status.tiles.upstreams,
			requests: tr.tiles.requests,
			errorRate: tr.tiles.errorRate,
			latencyP95: tr.tiles.latencyP95,
			caddyStartedAt: status.tiles.caddyStartedAt,
			certs: status.tiles.certs
		},
		series: tr.series,
		topSites: top.topSites,
		top: top.top,
		certs: status.certs,
		sources: status.sources
	};
}

export type OverviewPayload = ReturnType<typeof joinOverview>;

/** The whole Overview computed now, without the snapshot. */
export function overview(c: Collector, db: Db, range: Range, now = Date.now(), t?: Timing): OverviewPayload {
	return joinOverview(
		overviewStatus(c, db, now, t),
		overviewTraffic(db, range, now, t),
		overviewTop(c, db, range, now, t)
	);
}
