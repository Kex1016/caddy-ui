import type { Series, SourceName } from '$lib/design/charts';

/**
 * What each number on the stats pages is drawn from, and what to say when it is missing. Mirrors the
 * `sources` block every collector payload carries (apps/ui/src/lib/server/collector/README.md).
 */
export type Sources = {
	caddyfile: { ok: boolean; error: string | null; sites: number };
	probes: { ok: boolean; lastRun: number | null; intervalMs: number };
	metrics: { ok: boolean; lastRun: number | null; error: string | null; perHost: boolean };
	logs: { ok: boolean; found: boolean; path: string; lastEntry: number | null; error: string | null };
	certs: { ok: boolean; count: number; error: string | null };
	admin?: { ok: boolean };
};

const NOTE: Record<SourceName, string> = {
	metrics: "From Caddy's /metrics",
	logs: 'From the access log',
	probes: "From the UI's probes"
};

/** The card-foot line naming where a chart's numbers come from. */
export function sourceNote(source: SourceName | null | undefined): string | undefined {
	return source ? NOTE[source] : undefined;
}

/** When a source last produced data, for the as-of time of a chart drawn from it. */
export function lastGood(source: SourceName, s: Sources): number | null {
	if (source === 'metrics') return s.metrics.lastRun;
	if (source === 'logs') return s.logs.lastEntry;
	return s.probes.lastRun;
}

/**
 * A chart is stale when its source is failing now, so the numbers are the last good ones. The probe source
 * also counts as stale when its last run is more than three intervals old.
 */
export function isStale(source: SourceName | null, s: Sources, now: number): boolean {
	if (!source) return false;
	if (source === 'metrics') return !s.metrics.ok;
	if (source === 'logs') return !s.logs.ok;
	return !s.probes.ok || (s.probes.lastRun !== null && now - s.probes.lastRun > 3 * s.probes.intervalMs);
}

/** Frame props for a chart from its series: source note, as-of time (last good when stale) and the empty line. */
export function frameFor(series: Series, s: Sources, asOf: number, kind: 'traffic' | 'process' | 'probes') {
	const stale = isStale(series.source, s, asOf);
	return {
		note: sourceNote(series.source),
		asOf: stale && series.source ? (lastGood(series.source, s) ?? asOf) : asOf,
		stale,
		emptyTitle: series.source ? 'Nothing recorded in this range' : 'No source for this chart',
		emptyLine: series.source ? 'It fills in as Caddy serves requests.' : missingLine(kind, s)
	};
}

/** Names the fix when a chart has no source at all (Fishnet: an empty state says what is missing). */
export function missingLine(kind: 'traffic' | 'process' | 'probes' | 'top', s: Sources): string {
	if (kind === 'probes') {
		return s.probes.lastRun === null
			? 'The first probe runs within one probe interval of the UI starting.'
			: 'This site has no address the UI can probe.';
	}
	if (kind === 'top') {
		return s.logs.found
			? `The access log at ${s.logs.path} has no entries for this range.`
			: `Top paths and client IPs come from Caddy's JSON access log. Add a log directive that writes to ${s.logs.path}, or set CADDY_LOG_PATH to where it writes.`;
	}
	if (s.metrics.error) return `Caddy's /metrics could not be read: ${s.metrics.error}.`;
	if (kind === 'process') return "Caddy's /metrics has not been scraped yet.";
	return s.metrics.lastRun !== null && !s.metrics.perHost
		? 'Add metrics { per_host } to the global options of the Caddyfile for per-site traffic, or a log directive for the access log.'
		: 'Add metrics { per_host } to the global options of the Caddyfile, or a log directive for the access log.';
}

/** Page-level notices about sources that are off or failing; each names the fix. */
export function sourceNotices(s: Sources): { kind: 'warning' | 'info'; title: string; line: string }[] {
	const out: { kind: 'warning' | 'info'; title: string; line: string }[] = [];
	if (s.caddyfile.error)
		out.push({ kind: 'warning', title: 'The Caddyfile could not be read.', line: s.caddyfile.error });
	if (s.admin && !s.admin.ok)
		out.push({
			kind: 'warning',
			title: "Caddy's admin API is not answering.",
			line: 'Upstream request counts and failures are missing until it does; probes keep running.'
		});
	if (s.metrics.error)
		out.push({
			kind: 'warning',
			title: "Caddy's metrics are failing.",
			line: `${s.metrics.error}. Charts show the last good data.`
		});
	else if (s.metrics.lastRun !== null && !s.metrics.perHost)
		out.push({
			kind: 'info',
			title: 'Per-site metrics are off.',
			line: 'Add metrics { per_host } to the global options of the Caddyfile so each site gets its own request and latency charts.'
		});
	if (s.logs.error)
		out.push({ kind: 'warning', title: 'The access log could not be read.', line: s.logs.error });
	if (s.certs.error)
		out.push({ kind: 'warning', title: 'Certificates could not be read.', line: s.certs.error });
	return out;
}
