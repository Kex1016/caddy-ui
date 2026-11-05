import { createHash } from 'node:crypto';

/** Pure helpers that read Caddy's JSON config and Prometheus metrics. */

/** JSON with object keys sorted at every level, so two equal configs give the same string. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
		return out;
	}
	return value;
}

export function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash of a JSON config that ignores key order; null and an empty object hash the same. */
export function configHash(config: unknown): string {
	const empty =
		config === null || config === undefined || (typeof config === 'object' && !Object.keys(config).length);
	return sha256(empty ? '{}' : canonicalJson(config));
}

export function sameConfig(a: unknown, b: unknown): boolean {
	return configHash(a) === configHash(b);
}

type Sample = { name: string; labels: Record<string, string>; value: number };

/** Minimal Prometheus text-format reader: enough for single samples, not histograms' semantics. */
export function parseMetrics(text: string): Sample[] {
	const out: Sample[] = [];
	for (const line of text.split('\n')) {
		if (!line || line.startsWith('#')) continue;
		const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
		if (!m) continue;
		const labels: Record<string, string> = {};
		for (const l of (m[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
			labels[l[1] as string] = (l[2] as string).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
		}
		const value = Number(m[3]);
		if (!Number.isNaN(value)) out.push({ name: m[1] as string, labels, value });
	}
	return out;
}

export type ProcessFacts = {
	version: string | null;
	startedAt: number | null;
	lastReload: { ok: boolean; at: number | null } | null;
};

/** Caddy's start time, last reload and (when exported) version, from its own metrics. */
export function processFacts(metricsText: string): ProcessFacts {
	const samples = parseMetrics(metricsText);
	const find = (name: string) => samples.find((s) => s.name === name);
	const start = find('process_start_time_seconds');
	const reloadOk = find('caddy_config_last_reload_successful');
	const reloadAt = find('caddy_config_last_reload_success_timestamp_seconds');
	const build = samples.find(
		(s) => /build_info$/.test(s.name) && s.name !== 'go_build_info' && s.labels.version
	);
	return {
		version: build?.labels.version ?? null,
		startedAt: start ? Math.round(start.value * 1000) : null,
		lastReload: reloadOk
			? {
					ok: reloadOk.value === 1,
					at: reloadAt && reloadAt.value > 0 ? Math.round(reloadAt.value * 1000) : null
				}
			: null
	};
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Host names a route matches, from its `match` sets; empty when it matches every host. */
function routeHosts(route: Json): string[] {
	const hosts = new Set<string>();
	for (const set of arr(route.match)) {
		if (isObj(set)) for (const h of arr(set.host)) if (typeof h === 'string') hosts.add(h);
	}
	return [...hosts];
}

/**
 * Map each reverse_proxy upstream dial address to the hosts of the routes that lead to it, walking nested
 * subroutes (handle, route, handle_path and friends adapt to `subroute` handlers). Upstreams reached from a
 * route with no host matcher inherit the nearest enclosing host list.
 */
export function upstreamOwners(config: unknown): Map<string, string[][]> {
	const owners = new Map<string, string[][]>();
	const add = (dial: string, hosts: string[]) => {
		const list = owners.get(dial) ?? [];
		if (!list.some((h) => h.join(',') === hosts.join(','))) list.push(hosts);
		owners.set(dial, list);
	};
	const walkRoutes = (routes: unknown, inherited: string[]) => {
		for (const route of arr(routes)) {
			if (!isObj(route)) continue;
			const own = routeHosts(route);
			const hosts = own.length ? own : inherited;
			for (const h of arr(route.handle)) walkHandler(h, hosts);
		}
	};
	const walkHandler = (h: unknown, hosts: string[]) => {
		if (!isObj(h)) return;
		if (h.handler === 'reverse_proxy') {
			for (const u of arr(h.upstreams)) if (isObj(u) && typeof u.dial === 'string') add(u.dial, hosts);
		}
		if (h.handler === 'subroute') walkRoutes(h.routes, hosts);
		// handle_response routes inside reverse_proxy, and error routes, can hold more proxies.
		for (const hr of arr(h.handle_response)) if (isObj(hr)) walkRoutes(hr.routes, hosts);
	};
	const apps = isObj(config) && isObj(config.apps) ? config.apps : {};
	const http = isObj(apps.http) ? apps.http : {};
	const servers = isObj(http.servers) ? http.servers : {};
	for (const server of Object.values(servers)) {
		if (!isObj(server)) continue;
		walkRoutes(server.routes, []);
		if (isObj(server.errors)) walkRoutes(server.errors.routes, []);
	}
	return owners;
}
