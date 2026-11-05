import { createHash } from 'node:crypto';
import { parse, positionAt, type Node } from '@caddy-ui/caddyfile';

/**
 * What the collector needs from the Caddyfile: each site block's addresses and the upstreams it proxies to.
 * Built on the CST from `packages/caddyfile` (W1); only the directives that name upstreams are interpreted.
 */
export type Upstream = {
	/** The address as written, for example `10.0.0.5:8080` or `https://10.0.0.7`. */
	address: string;
	/** The directive it came from: reverse_proxy, forward_auth or php_fastcgi. */
	via: string;
};

export type SiteBlock = {
	id: string;
	addresses: string[];
	upstreams: Upstream[];
	/** 1-based line of the block's first address, for links into the editor. */
	line: number;
};

const UPSTREAM_DIRECTIVES = new Set(['reverse_proxy', 'forward_auth', 'php_fastcgi']);

function isMatcherToken(text: string): boolean {
	return text.startsWith('@') || text.startsWith('/') || text === '*';
}

function collectUpstreams(
	body: readonly Node[],
	snippets: Map<string, Node[]>,
	seen: Set<string>,
	out: Upstream[]
) {
	const add = (address: string, via: string) => {
		// Placeholders and env vars resolve at request time, so there is nothing fixed to probe.
		if (address.includes('{') || address.startsWith('unix/')) return;
		if (!out.some((u) => u.address === address)) out.push({ address, via });
	};
	for (const node of body) {
		if (node.kind !== 'directive') {
			if (node.kind === 'raw' && node.body) collectUpstreams(node.body, snippets, seen, out);
			continue;
		}
		const name = node.name.text;
		if (name === 'import') {
			const target = node.args[0]?.text;
			const snip = target ? snippets.get(target) : undefined;
			if (target && snip && !seen.has(target)) {
				seen.add(target);
				collectUpstreams(snip, snippets, seen, out);
				seen.delete(target);
			}
			continue;
		}
		if (UPSTREAM_DIRECTIVES.has(name)) {
			const args = node.args.map((t) => t.text);
			// The parser only classifies matchers inside directive bodies; strip one it left in place.
			if (node.matcher === undefined && args[0] !== undefined && isMatcherToken(args[0])) args.shift();
			for (const a of args) add(a, name);
			for (const sub of node.body ?? []) {
				if (sub.kind === 'directive' && sub.name.text === 'to') for (const t of sub.args) add(t.text, name);
			}
			continue;
		}
		if (node.body) collectUpstreams(node.body, snippets, seen, out);
	}
}

/** Lower-cases, trims and sorts addresses so cosmetic edits keep a site's identity and history. */
export function siteId(addresses: string[]): string {
	const key = addresses
		.map((a) => a.trim().toLowerCase())
		.filter(Boolean)
		.sort()
		.join(',');
	return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function scanCaddyfile(src: string): SiteBlock[] {
	const { file } = parse(src);
	const snippets = new Map<string, Node[]>();
	for (const block of file.blocks) {
		if (block.kind === 'snippet') snippets.set(block.name, block.body);
	}
	const sites: SiteBlock[] = [];
	for (const block of file.blocks) {
		if (block.kind !== 'site') continue;
		const addresses = block.addresses
			.flatMap((t) => t.text.split(','))
			.map((a) => a.trim())
			.filter(Boolean);
		if (addresses.length === 0) continue;
		const upstreams: Upstream[] = [];
		collectUpstreams(block.body, snippets, new Set(), upstreams);
		const first = block.addresses[0]!;
		const line = first.span ? positionAt(src, first.span.start).line : 1;
		sites.push({ id: siteId(addresses), addresses, upstreams, line });
	}
	return sites;
}

export type ParsedAddress = { scheme?: string; host: string; port?: number; path?: string };

/** Splits a site address such as `https://example.com:8443/api*` into its parts. */
export function parseAddress(addr: string): ParsedAddress {
	let rest = addr.trim();
	let scheme: string | undefined;
	const s = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
	if (s) {
		scheme = (s[1] as string).toLowerCase();
		rest = rest.slice(s[0].length);
	}
	let path: string | undefined;
	const slash = rest.indexOf('/');
	if (slash >= 0) {
		path = rest.slice(slash);
		rest = rest.slice(0, slash);
	}
	let host = rest;
	let port: number | undefined;
	const p = /^(.*?)(?::(\d+))?$/.exec(rest.startsWith('[') ? rest.replace(/^\[(.*)\]/, '$1') : rest);
	if (p) {
		host = p[1] as string;
		port = p[2] ? Number(p[2]) : undefined;
	}
	return { scheme, host: host.toLowerCase(), port, path };
}

export type ProbeTarget = { url: string; hostHeader?: string; servername?: string };

/**
 * The URL the collector requests to check a site through Caddy, or undefined when no address can be probed
 * (only wildcards, or only placeholders). The request goes to Caddy itself (`connectHost`) with the site's
 * name as Host and SNI, so it works without hairpin DNS from inside the compose network.
 */
export function probeTarget(addresses: string[], connectHost: string): ProbeTarget | undefined {
	for (const raw of addresses) {
		if (raw.includes('{')) continue;
		const a = parseAddress(raw);
		if (a.host.includes('*')) continue;
		const scheme = a.scheme ?? (a.port === 80 ? 'http' : a.host === '' && a.port ? 'http' : 'https');
		if (scheme !== 'http' && scheme !== 'https') continue;
		const port = a.port ?? (scheme === 'http' ? 80 : 443);
		const defaultPort = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
		const path = a.path ? a.path.replace(/\*.*$/, '') || '/' : '/';
		const url = `${scheme}://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}${defaultPort ? '' : `:${port}`}${path}`;
		if (a.host === '') return { url };
		const hostHeader = defaultPort ? a.host : `${a.host}:${port}`;
		return { url, hostHeader, servername: scheme === 'https' ? a.host : undefined };
	}
	return undefined;
}

export type UpstreamTarget = { host: string; port: number; scheme?: 'http' | 'https' };

/** Where to connect for an upstream address. Caddy's default upstream port is 80. */
export function upstreamTarget(address: string): UpstreamTarget | undefined {
	const a = parseAddress(address);
	if (a.host === '' && a.port === undefined) return undefined;
	let scheme: 'http' | 'https' | undefined;
	if (a.scheme === 'https') scheme = 'https';
	else if (a.scheme === 'http' || a.scheme === 'h2c') scheme = 'http';
	else if (a.scheme !== undefined) return undefined;
	const port = a.port ?? (scheme === 'https' ? 443 : 80);
	return { host: a.host || 'localhost', port, scheme };
}

/** Maps a request host (from a log line or a metrics label) to the site block that serves it. */
export class HostMatcher {
	private exact = new Map<string, string>();
	private wild: { suffix: string; id: string }[] = [];
	/** Blocks like `:8080` serve any host on that port. */
	private byPort = new Map<number, string>();

	constructor(sites: SiteBlock[]) {
		for (const s of sites) {
			for (const raw of s.addresses) {
				const { host, port } = parseAddress(raw);
				if (host === '') {
					if (port !== undefined && !this.byPort.has(port)) this.byPort.set(port, s.id);
				} else if (host.startsWith('*.')) this.wild.push({ suffix: host.slice(1), id: s.id });
				else if (!this.exact.has(host)) this.exact.set(host, s.id);
			}
		}
	}

	match(requestHost: string): string | undefined {
		const m = /^(?:\[(.*)\]|([^:]*))(?::(\d+))?$/.exec(requestHost.toLowerCase());
		const host = m ? (m[1] ?? m[2] ?? '') : requestHost.toLowerCase();
		const port = m?.[3] ? Number(m[3]) : undefined;
		const hit = this.exact.get(host);
		if (hit) return hit;
		for (const w of this.wild) {
			if (host.endsWith(w.suffix) && !host.slice(0, -w.suffix.length).includes('.')) return w.id;
		}
		return port !== undefined ? this.byPort.get(port) : undefined;
	}
}
