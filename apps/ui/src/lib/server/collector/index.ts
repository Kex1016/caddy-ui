import { config } from '../env';
import { getDb, type Db } from '../db';
import {
	allCerts,
	certFor,
	gaugeSeries,
	latestGauge,
	latestProbes,
	probeLatency,
	requestsBySite,
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
import { loadStates, type State } from './store';
import { Collector, type CollectorStatus } from './worker';

export { Collector } from './worker';
export { parseRange, RANGES, type Range } from './queries';

const KEY = Symbol.for('caddy-ui.collector');
type G = typeof globalThis & { [KEY]?: Collector };

/** The process-wide collector, created on first use. Kept on globalThis so dev-server reloads reuse it. */
export function getCollector(): Collector {
	const g = globalThis as G;
	g[KEY] ??= new Collector(getDb(), config());
	return g[KEY];
}

let started = false;

export function startCollector(): void {
	if (started) return;
	started = true;
	const c = getCollector();
	c.start();
	process.once('sveltekit:shutdown', () => c.stop());
}

/** Live passive-health data from Caddy's admin API, cached briefly so a page load costs one request. */
type LiveUpstream = { address: string; num_requests: number; fails: number };
let liveCache: { at: number; data: Map<string, LiveUpstream> | null } | undefined;

export async function liveUpstreams(
	adminUrl: string,
	now = Date.now()
): Promise<Map<string, LiveUpstream> | null> {
	if (liveCache && now - liveCache.at < 5_000) return liveCache.data;
	let data: Map<string, LiveUpstream> | null = null;
	try {
		const res = await fetch(`${adminUrl}/reverse_proxy/upstreams`, { signal: AbortSignal.timeout(2_000) });
		if (res.ok) {
			const list = (await res.json()) as LiveUpstream[];
			data = new Map((Array.isArray(list) ? list : []).map((u) => [u.address, u]));
		}
	} catch {
		data = null;
	}
	liveCache = { at: now, data };
	return data;
}

export function resetLiveCacheForTests() {
	liveCache = undefined;
}

export type SourceSummary = {
	caddyfile: { ok: boolean; error: string | null; sites: number };
	probes: { ok: boolean; lastRun: number | null; intervalMs: number };
	metrics: { ok: boolean; lastRun: number | null; error: string | null; perHost: boolean };
	logs: { ok: boolean; found: boolean; path: string; lastEntry: number | null; error: string | null };
	certs: { ok: boolean; count: number; error: string | null };
	admin?: { ok: boolean };
};

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

export async function sitesPayload(
	c: Collector,
	db: Db,
	adminUrl: string,
	now = Date.now()
): Promise<SitesPayload> {
	if (c.status.caddyfile.lastRun === null) c.refreshSites();
	const states = loadStates(db);
	const probes = latestProbes(db);
	const certs = allCerts(db, now);
	const live = await liveUpstreams(adminUrl, now);
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
			uptime24h: uptimeRatio(stateSpans(db, s.id, '', now - 86_400_000, now))
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

export async function overview(c: Collector, db: Db, range: Range, now = Date.now()) {
	if (c.status.caddyfile.lastRun === null) c.refreshSites();
	const w = window(range, now);
	const states = loadStates(db);
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
	const t = traffic(db, '*', w);
	const requests = total(t.requests);
	const errors5xx = total(t.errors5xx);
	const start = latestGauge(db, 'process_start_time_seconds', { site: '*' });
	const certs = allCerts(db, now);
	const siteNames = new Map(c.sites.map((s) => [s.id, s.addresses[0] ?? s.id]));
	return {
		asOf: now,
		range,
		from: w.from,
		to: w.to,
		stepMs: w.stepMs,
		tiles: {
			sites: counts,
			upstreams: ups,
			requests: { value: requests, source: t.requests.source },
			errorRate: {
				value:
					requests && errors5xx !== null
						? Math.round((errors5xx / requests) * 10000) / 10000
						: requests === 0
							? 0
							: null,
				source: t.errors5xx.source
			},
			latencyP95: { value: weightedMean(t.latencyP95, t.requests), source: t.latencyP95.source },
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
		series: {
			...t,
			memory: gaugeSeries(db, 'process_resident_memory_bytes', w),
			goroutines: gaugeSeries(db, 'go_goroutines', w)
		},
		topSites: requestsBySite(db, w)
			.slice(0, 10)
			.map((r) => ({ ...r, label: siteNames.get(r.siteId) ?? r.siteId })),
		top: topLists(db, '*', w),
		certs,
		sources: sources(c.status)
	};
}
