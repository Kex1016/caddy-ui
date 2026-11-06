/**
 * Turns Caddy's Prometheus `/metrics` into per-minute rows for `metric_samples`.
 *
 * Caddy instruments every HTTP handler separately, so one request through `subroute` → `reverse_proxy` is
 * counted once per handler. Per (server, host) the collector therefore uses only the handler that saw the
 * most requests, which is the outermost one for a Caddyfile site block. With `metrics { per_host }` every
 * series carries a `host` label and is attributed to its site; without it only server-wide rows ('*') exist.
 */

export type Sample = { name: string; labels: Record<string, string>; value: number };

function unescapeLabel(v: string): string {
	return v.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

/** Parses the Prometheus text exposition format (0.0.4). Comments and malformed lines are skipped. */
export function parsePrometheus(text: string): Sample[] {
	const out: Sample[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(\s+\d+)?$/.exec(line);
		if (!m) continue;
		const labels: Record<string, string> = {};
		if (m[3]) {
			const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
			let lm: RegExpExecArray | null;
			while ((lm = re.exec(m[3])) !== null) labels[lm[1] as string] = unescapeLabel(lm[2] as string);
		}
		const v = m[4] as string;
		const value = v === '+Inf' ? Infinity : v === '-Inf' ? -Infinity : Number(v);
		if (Number.isNaN(value) && v !== 'NaN') continue;
		out.push({ name: m[1] as string, labels, value });
	}
	return out;
}

/** histogram_quantile: linear interpolation inside the bucket that holds the q-th observation. */
export function quantile(q: number, buckets: Map<number, number>): number | null {
	const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
	const total = sorted.find(([le]) => le === Infinity)?.[1] ?? sorted[sorted.length - 1]?.[1] ?? 0;
	if (total <= 0) return null;
	const rank = q * total;
	let prevLe = 0;
	let prevCount = 0;
	for (const [le, count] of sorted) {
		if (count >= rank) {
			if (le === Infinity) return prevLe;
			if (count === prevCount) return le;
			return prevLe + ((le - prevLe) * (rank - prevCount)) / (count - prevCount);
		}
		prevLe = le;
		prevCount = count;
	}
	return prevLe;
}

export type MetricRow = { ts: number; name: string; labels: Record<string, string>; value: number };

type SiteAcc = {
	requests: number;
	e4: number;
	e5: number;
	bytes: number;
	buckets: Map<number, number>;
	inFlight: number;
};

const newAcc = (): SiteAcc => ({ requests: 0, e4: 0, e5: 0, bytes: 0, buckets: new Map(), inFlight: 0 });

const MINUTE = 60_000;

const PROCESS_GAUGES = [
	'process_resident_memory_bytes',
	'go_goroutines',
	'process_open_fds',
	'process_start_time_seconds',
	'go_memstats_heap_inuse_bytes'
];

function seriesKey(s: Sample): string {
	const keys = Object.keys(s.labels).sort();
	return s.name + '{' + keys.map((k) => `${k}=${s.labels[k]}`).join(',') + '}';
}

/**
 * Keeps the previous scrape so counters become per-minute deltas. Feed it every scrape; it returns rows for
 * each minute that has closed.
 */
export class MetricsRollup {
	private prev = new Map<string, number>();
	private minute: number | undefined;
	private sites = new Map<string, SiteAcc>();
	private gauges = new Map<string, MetricRow>();
	/** True once any scrape carried a `host` label, which means `metrics { per_host }` is on. */
	perHost = false;

	constructor(private siteFor: (host: string) => string | undefined) {}

	private delta(s: Sample): number {
		const key = seriesKey(s);
		const before = this.prev.get(key);
		this.prev.set(key, s.value);
		if (before === undefined) return 0; // first sight: baseline only
		return s.value >= before ? s.value - before : s.value; // counter reset (Caddy restarted)
	}

	private acc(site: string): SiteAcc {
		let a = this.sites.get(site);
		if (!a) {
			a = newAcc();
			this.sites.set(site, a);
		}
		return a;
	}

	feed(samples: Sample[], ts: number): MetricRow[] {
		const minute = Math.floor(ts / MINUTE) * MINUTE;
		const rows: MetricRow[] = [];
		if (this.minute !== undefined && minute !== this.minute) rows.push(...this.flush());
		this.minute = minute;

		// Pick the representative handler per (server, host) by request count.
		const perHandler = new Map<string, number>();
		for (const s of samples) {
			if (s.name !== 'caddy_http_request_duration_seconds_count') continue;
			const k = `${s.labels.server ?? ''}|${s.labels.host ?? ''}|${s.labels.handler ?? ''}`;
			perHandler.set(k, (perHandler.get(k) ?? 0) + s.value);
		}
		const counts = new Map<string, { handler: string; count: number }>();
		for (const [k, count] of perHandler) {
			const cut = k.lastIndexOf('|');
			const group = k.slice(0, cut);
			const best = counts.get(group);
			if (!best || count > best.count) counts.set(group, { handler: k.slice(cut + 1), count });
		}
		const chosen = (s: Sample) =>
			counts.get(`${s.labels.server ?? ''}|${s.labels.host ?? ''}`)?.handler === (s.labels.handler ?? '');

		const inFlight = new Map<string, number>();
		for (const s of samples) {
			const isHttp = s.name.startsWith('caddy_http_');
			if (!isHttp) {
				if (PROCESS_GAUGES.includes(s.name)) {
					this.gauges.set(s.name, { ts: minute, name: s.name, labels: { site: '*' }, value: s.value });
				} else if (s.name === 'caddy_reverse_proxy_upstreams_healthy' && s.labels.upstream) {
					this.gauges.set(`up:${s.labels.upstream}`, {
						ts: minute,
						name: 'upstream_healthy',
						labels: { upstream: s.labels.upstream },
						value: s.value
					});
				}
				continue;
			}
			if (s.labels.host !== undefined) this.perHost = true;
			const site = s.labels.host !== undefined ? this.siteFor(s.labels.host) : undefined;
			const targets = site ? ['*', site] : ['*'];

			if (s.name === 'caddy_http_requests_in_flight') {
				// Gauge: take the busiest handler per server, then sum servers.
				const k = `${s.labels.server ?? ''}|${site ?? '*'}`;
				inFlight.set(k, Math.max(inFlight.get(k) ?? 0, s.value));
				continue;
			}
			const counter =
				s.name === 'caddy_http_request_duration_seconds_count' ||
				s.name === 'caddy_http_request_duration_seconds_bucket' ||
				s.name === 'caddy_http_response_size_bytes_sum';
			if (!counter) continue;
			const d = this.delta(s);
			if (!chosen(s) || d === 0) continue;
			for (const t of targets) {
				const a = this.acc(t);
				if (s.name === 'caddy_http_request_duration_seconds_count') {
					a.requests += d;
					const code = Number(s.labels.code);
					if (code >= 400 && code < 500) a.e4 += d;
					if (code >= 500) a.e5 += d;
				} else if (s.name === 'caddy_http_response_size_bytes_sum') {
					a.bytes += d;
				} else {
					const le = s.labels.le === '+Inf' ? Infinity : Number(s.labels.le);
					if (!Number.isNaN(le)) a.buckets.set(le, (a.buckets.get(le) ?? 0) + d);
				}
			}
		}
		const totals = new Map<string, number>();
		for (const [k, v] of inFlight) {
			const site = k.slice(k.indexOf('|') + 1);
			for (const t of site === '*' ? ['*'] : ['*', site]) totals.set(t, (totals.get(t) ?? 0) + v);
		}
		// Peak over the minute's scrapes.
		for (const [t, v] of totals) {
			const a = this.acc(t);
			a.inFlight = Math.max(a.inFlight, v);
		}
		if (inFlight.size > 0) this.inFlightSeen = true;
		return rows;
	}

	private inFlightSeen = false;

	/** Rows for the open minute. Called on minute change and on shutdown. */
	flush(): MetricRow[] {
		if (this.minute === undefined) return [];
		const ts = this.minute;
		const rows: MetricRow[] = [];
		const server = this.sites.get('*') ?? newAcc();
		this.sites.set('*', server);
		for (const [site, a] of this.sites) {
			// Idle sites write nothing; a missing minute reads as zero. The server row is always written so a
			// gap in it means the scrape failed, not that the server was idle.
			if (site !== '*' && a.requests === 0 && a.inFlight === 0) continue;
			const labels = { site };
			rows.push({ ts, name: 'requests', labels, value: a.requests });
			rows.push({ ts, name: 'errors_4xx', labels, value: a.e4 });
			rows.push({ ts, name: 'errors_5xx', labels, value: a.e5 });
			rows.push({ ts, name: 'bytes_out', labels, value: a.bytes });
			if (this.inFlightSeen) rows.push({ ts, name: 'in_flight', labels, value: a.inFlight });
			const p50 = quantile(0.5, a.buckets);
			const p95 = quantile(0.95, a.buckets);
			if (p50 !== null) rows.push({ ts, name: 'latency_p50_ms', labels, value: Math.round(p50 * 1e4) / 10 });
			if (p95 !== null) rows.push({ ts, name: 'latency_p95_ms', labels, value: Math.round(p95 * 1e4) / 10 });
		}
		for (const g of this.gauges.values()) rows.push({ ...g, ts });
		this.sites.clear();
		this.gauges.clear();
		this.inFlightSeen = false;
		return rows;
	}
}
