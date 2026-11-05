import { createHash } from 'node:crypto';

/**
 * What the collector needs from the Caddyfile: each site block's addresses and the upstreams it proxies to.
 *
 * This is a deliberately small scanner, not the real parser. `packages/caddyfile` (W1) owns parsing; once it
 * lands, `scanCaddyfile` should be reimplemented on top of its CST with the same output. Until then this
 * understands just enough: comments, quotes, backticks, heredocs, braces, snippets, named routes, `import`
 * of snippets, and the directives that name upstreams.
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

type Tok = { text: string; line: number; quoted: boolean };

/** Splits Caddyfile text into tokens with line numbers. Tokens on one line form one directive. */
export function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	let line = 1;
	const n = src.length;
	while (i < n) {
		const c = src[i] as string;
		if (c === '\n') {
			line++;
			i++;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\r') {
			i++;
			continue;
		}
		if (c === '#') {
			while (i < n && src[i] !== '\n') i++;
			continue;
		}
		const startLine = line;
		if (c === '"' || c === '`') {
			let text = '';
			i++;
			while (i < n && src[i] !== c) {
				if (c === '"' && src[i] === '\\' && (src[i + 1] === '"' || src[i + 1] === '\\')) {
					text += src[i + 1];
					i += 2;
					continue;
				}
				if (src[i] === '\n') line++;
				text += src[i];
				i++;
			}
			i++;
			out.push({ text, line: startLine, quoted: true });
			continue;
		}
		const heredoc = /^<<([A-Za-z0-9_-]+)[ \t]*\r?\n/.exec(src.slice(i, i + 64));
		if (heredoc) {
			const marker = heredoc[1] as string;
			i += heredoc[0].length;
			line++;
			const close = new RegExp(`^[ \\t]*${marker}(?=\\s|$)`, 'm');
			const rest = src.slice(i);
			const m = close.exec(rest);
			const body = m ? rest.slice(0, m.index) : rest;
			line += body.split('\n').length - 1;
			i += m ? m.index + m[0].length : rest.length;
			out.push({ text: body, line: startLine, quoted: true });
			continue;
		}
		let text = '';
		while (i < n && !/\s/.test(src[i] as string)) {
			text += src[i];
			i++;
		}
		out.push({ text, line: startLine, quoted: false });
	}
	return out;
}

const isOpen = (t: Tok | undefined) => t !== undefined && !t.quoted && t.text === '{';
const isClose = (t: Tok | undefined) => t !== undefined && !t.quoted && t.text === '}';

type Line = { toks: Tok[]; body?: Line[] };

/** Groups tokens into lines, nesting `{ … }` bodies under the line that opens them. */
function group(toks: Tok[]): Line[] {
	let pos = 0;
	function lines(): Line[] {
		const out: Line[] = [];
		while (pos < toks.length) {
			const first = toks[pos] as Tok;
			if (isClose(first)) {
				pos++;
				return out;
			}
			const ln: Line = { toks: [] };
			// A site's address list may continue onto the next line after a trailing comma.
			while (pos < toks.length) {
				const t = toks[pos] as Tok;
				const prev = ln.toks[ln.toks.length - 1];
				const continues = prev !== undefined && prev.text.endsWith(',') && !prev.quoted;
				if (prev !== undefined && t.line !== prev.line && !continues) break;
				if (isClose(t)) break;
				if (isOpen(t)) {
					pos++;
					ln.body = lines();
					break;
				}
				ln.toks.push(t);
				pos++;
			}
			if (ln.toks.length > 0 || ln.body) out.push(ln);
		}
		return out;
	}
	return lines();
}

const UPSTREAM_DIRECTIVES = new Set(['reverse_proxy', 'forward_auth', 'php_fastcgi']);

function isMatcherToken(text: string): boolean {
	return text.startsWith('@') || text.startsWith('/') || text === '*';
}

function collectUpstreams(body: Line[], snippets: Map<string, Line[]>, seen: Set<string>, out: Upstream[]) {
	const add = (address: string, via: string) => {
		// Placeholders and env vars resolve at request time, so there is nothing fixed to probe.
		if (address.includes('{') || address.startsWith('unix/')) return;
		if (!out.some((u) => u.address === address)) out.push({ address, via });
	};
	for (const ln of body) {
		const name = ln.toks[0]?.text;
		if (name === undefined) {
			if (ln.body) collectUpstreams(ln.body, snippets, seen, out);
			continue;
		}
		if (name === 'import') {
			const target = ln.toks[1]?.text;
			const snip = target ? snippets.get(target) : undefined;
			if (target && snip && !seen.has(target)) {
				seen.add(target);
				collectUpstreams(snip, snippets, seen, out);
				seen.delete(target);
			}
			continue;
		}
		if (UPSTREAM_DIRECTIVES.has(name)) {
			const args = ln.toks.slice(1).map((t) => t.text);
			if (args[0] !== undefined && isMatcherToken(args[0])) args.shift();
			for (const a of args) add(a, name);
			for (const sub of ln.body ?? []) {
				if (sub.toks[0]?.text === 'to') for (const t of sub.toks.slice(1)) add(t.text, name);
			}
			continue;
		}
		if (ln.body) collectUpstreams(ln.body, snippets, seen, out);
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
	const top = group(tokenize(src));
	const snippets = new Map<string, Line[]>();
	for (const ln of top) {
		const head = ln.toks[0]?.text ?? '';
		if (ln.toks.length === 1 && /^\(.+\)$/.test(head) && ln.body) snippets.set(head.slice(1, -1), ln.body);
	}
	const sites: SiteBlock[] = [];
	for (const [index, ln] of top.entries()) {
		const head = ln.toks[0]?.text;
		if (head === undefined) continue; // global options block
		if (/^&?\(.+\)$/.test(head)) continue; // snippet or named route
		const addresses = ln.toks
			.flatMap((t) => t.text.split(','))
			.map((a) => a.trim())
			.filter(Boolean);
		if (addresses.length === 0) continue;
		// A Caddyfile with a single site may omit the braces; then the rest of the file is its body.
		const body = ln.body ?? (index === top.findIndex((l) => l.toks.length > 0) ? top.slice(index + 1) : []);
		const upstreams: Upstream[] = [];
		collectUpstreams(body, snippets, new Set(), upstreams);
		sites.push({ id: siteId(addresses), addresses, upstreams, line: (ln.toks[0] as Tok).line });
		if (!ln.body) break;
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
