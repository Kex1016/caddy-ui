import { describe, expect, it } from 'vitest';
import { MetricsRollup, parsePrometheus, quantile } from './metrics';

/** A trimmed Caddy /metrics page with `per_host` on. Two handlers see the same requests (subroute wraps reverse_proxy). */
function page(n: {
	a200: number;
	a502: number;
	b200: number;
	bytes: number;
	inflight: number;
	start?: number;
}) {
	const h = (handler: string, host: string, code: number, count: number) => {
		const lines = [
			`caddy_http_request_duration_seconds_bucket{code="${code}",handler="${handler}",host="${host}",method="GET",server="srv0",le="0.05"} ${Math.floor(count * 0.6)}`,
			`caddy_http_request_duration_seconds_bucket{code="${code}",handler="${handler}",host="${host}",method="GET",server="srv0",le="0.25"} ${Math.floor(count * 0.9)}`,
			`caddy_http_request_duration_seconds_bucket{code="${code}",handler="${handler}",host="${host}",method="GET",server="srv0",le="+Inf"} ${count}`,
			`caddy_http_request_duration_seconds_count{code="${code}",handler="${handler}",host="${host}",method="GET",server="srv0"} ${count}`,
			`caddy_http_response_size_bytes_sum{code="${code}",handler="${handler}",host="${host}",method="GET",server="srv0"} ${count === 0 ? 0 : n.bytes}`
		];
		return lines.join('\n');
	};
	return [
		'# HELP caddy_http_request_duration_seconds Histogram of round-trip request durations.',
		'# TYPE caddy_http_request_duration_seconds histogram',
		h('subroute', 'a.example.com', 200, n.a200),
		h('reverse_proxy', 'a.example.com', 200, Math.floor(n.a200 / 2)),
		h('subroute', 'a.example.com', 502, n.a502),
		h('subroute', 'b.example.com', 200, n.b200),
		`caddy_http_requests_in_flight{handler="subroute",server="srv0"} ${n.inflight}`,
		`caddy_reverse_proxy_upstreams_healthy{upstream="10.0.0.10:8080"} 1`,
		`process_resident_memory_bytes 5.24288e+07`,
		`go_goroutines 42`,
		`process_start_time_seconds ${n.start ?? 1.7e9}`
	].join('\n');
}

const sites: Record<string, string> = { 'a.example.com': 'A', 'b.example.com': 'B' };
const T0 = Date.UTC(2026, 10, 5, 12, 0, 10);

describe('parsePrometheus', () => {
	it('reads names, labels with escapes and special values', () => {
		const s = parsePrometheus('x{a="1",b="q\\"x"} 2.5\n# c\ny +Inf 1700000000\nbad line here\n');
		expect(s).toEqual([
			{ name: 'x', labels: { a: '1', b: 'q"x' }, value: 2.5 },
			{ name: 'y', labels: {}, value: Infinity }
		]);
	});
});

describe('quantile', () => {
	it('interpolates inside the bucket', () => {
		const b = new Map([
			[0.1, 50],
			[1, 100],
			[Infinity, 100]
		]);
		expect(quantile(0.5, b)).toBeCloseTo(0.1);
		expect(quantile(0.75, b)).toBeCloseTo(0.55);
		expect(quantile(0.5, new Map())).toBeNull();
	});
});

describe('MetricsRollup', () => {
	it('turns counters into per-minute deltas per site, counting each request once', () => {
		const r = new MetricsRollup((h) => sites[h]);
		expect(
			r.feed(parsePrometheus(page({ a200: 100, a502: 0, b200: 10, bytes: 1000, inflight: 1 })), T0)
		).toEqual([]);
		r.feed(parsePrometheus(page({ a200: 200, a502: 10, b200: 10, bytes: 3000, inflight: 3 })), T0 + 15_000);
		const rows = r.feed(
			parsePrometheus(page({ a200: 200, a502: 10, b200: 10, bytes: 3000, inflight: 0 })),
			T0 + 60_000
		);
		const get = (name: string, site: string) =>
			rows.find((x) => x.name === name && x.labels.site === site)?.value;
		const minute = Math.floor(T0 / 60_000) * 60_000;
		expect(rows.every((x) => x.ts === minute)).toBe(true);
		expect(get('requests', 'A')).toBe(110); // subroute only, not subroute + reverse_proxy
		expect(get('errors_5xx', 'A')).toBe(10);
		expect(get('requests', '*')).toBe(110);
		expect(get('bytes_out', 'A')).toBe(5000); // 200s grew 1000 → 3000, 502s 0 → 3000
		expect(get('requests', 'B')).toBeUndefined(); // idle sites write nothing
		expect(get('in_flight', '*')).toBe(3); // peak over the minute
		expect(get('latency_p50_ms', 'A')).toBeGreaterThan(0);
		expect(get('latency_p95_ms', 'A')).toBeGreaterThanOrEqual(get('latency_p50_ms', 'A') as number);
		expect(rows.find((x) => x.name === 'go_goroutines')?.value).toBe(42);
		expect(rows.find((x) => x.name === 'upstream_healthy')?.labels).toEqual({ upstream: '10.0.0.10:8080' });
		expect(r.perHost).toBe(true);
	});

	it('treats a counter that went down as a restart', () => {
		const r = new MetricsRollup((h) => sites[h]);
		r.feed(parsePrometheus(page({ a200: 500, a502: 0, b200: 0, bytes: 0, inflight: 0 })), T0);
		r.feed(parsePrometheus(page({ a200: 7, a502: 0, b200: 0, bytes: 0, inflight: 0 })), T0 + 15_000);
		const rows = r.flush();
		expect(rows.find((x) => x.name === 'requests' && x.labels.site === 'A')?.value).toBe(7);
	});

	it('writes a server row of zeros when nothing happened, so a gap means no scrape', () => {
		const r = new MetricsRollup(() => undefined);
		r.feed([], T0);
		const rows = r.flush();
		expect(rows.find((x) => x.name === 'requests')).toEqual({
			ts: Math.floor(T0 / 60_000) * 60_000,
			name: 'requests',
			labels: { site: '*' },
			value: 0
		});
	});
});
