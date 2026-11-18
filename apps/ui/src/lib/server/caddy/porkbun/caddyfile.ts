import { parse, positionAt, type Directive, type Node } from '@caddy-ui/caddyfile';
import type { Dns01 } from '$lib/api/porkbun-caddy';
import { parseAddress, siteId } from '../../collector/sites';

/**
 * What the Caddy tie-in needs from the Caddyfile (docs/porkbun-plan.md §4): each site's host names, and how
 * the site gets its certificate (through the DNS challenge or not). Pure: text in, facts out.
 */
export type SiteHost = {
	/** The address as written: `https://app.example.com:8443`. */
	address: string;
	/** Lower case, no scheme, port or path: `app.example.com`, `*.example.com`. */
	host: string;
	wildcard: boolean;
	/** False for `http://` addresses and port 80, which never get a certificate. */
	https: boolean;
};

export type SiteFacts = {
	id: string;
	addresses: string[];
	/** 1-based line of the block's first address. */
	line: number;
	/** The addresses that are host names; IPs, bare ports, `localhost` and placeholders are left out. */
	hosts: SiteHost[];
	/**
	 * Where the certificate comes from: `acme` (a public CA, Caddy's default), `internal` (Caddy's own CA),
	 * `files` (certificate and key files) or `off` (certificates are switched off globally).
	 */
	certificate: 'acme' | 'internal' | 'files' | 'off';
	/** `tls { on_demand }`: certificates are got per name at the first handshake, wildcard or not. */
	onDemand: boolean;
	dns01: Dns01 | null;
};

export type CaddyfileFacts = {
	sites: SiteFacts[];
	/** The global `acme_dns` option. */
	globalDns01: { provider: string | null } | null;
};

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** A site address as a host name, or null when it is not one. */
export function siteHost(address: string): SiteHost | null {
	if (address.includes('{')) return null;
	const a = parseAddress(address);
	const host = a.host.replace(/\.$/, '');
	if (host === '' || host.includes(':') || IPV4.test(host)) return null;
	const labels = host.split('.');
	if (labels.length < 2) return null;
	const wildcard = labels[0] === '*';
	if (!labels.slice(wildcard ? 1 : 0).every((l) => LABEL.test(l))) return null;
	if (labels.at(-1) === 'localhost') return null;
	const https = a.scheme !== 'http' && a.port !== 80;
	return { address, host, wildcard, https };
}

const directives = (body: readonly Node[], name: string): Directive[] =>
	body.filter((n): n is Directive => n.kind === 'directive' && n.name.text === name);

/** Every `tls` line that applies to a site: its own, and those of the snippets it imports. */
function tlsLines(
	body: readonly Node[],
	snippets: Map<string, Node[]>,
	seen = new Set<string>()
): Directive[] {
	const out: Directive[] = [];
	for (const node of body) {
		if (node.kind !== 'directive') continue;
		if (node.name.text === 'tls') out.push(node);
		else if (node.name.text === 'import') {
			const name = node.args[0]?.text;
			const snippet = name ? snippets.get(name) : undefined;
			if (name && snippet && !seen.has(name)) {
				seen.add(name);
				out.push(...tlsLines(snippet, snippets, seen));
				seen.delete(name);
			}
		}
	}
	return out;
}

type Globals = {
	acmeDns: { provider: string | null } | null;
	/** The provider of the global `dns` option, which a bare `dns` or `acme_dns` line falls back to. */
	defaultProvider: string | null;
	localCerts: boolean;
	certsOff: boolean;
};

function readGlobals(body: readonly Node[]): Globals {
	const first = (name: string) => directives(body, name)[0];
	const defaultProvider = first('dns')?.args[0]?.text ?? null;
	const acme = first('acme_dns');
	const autoHttps = first('auto_https')?.args.map((a) => a.text) ?? [];
	return {
		acmeDns: acme ? { provider: acme.args[0]?.text ?? defaultProvider } : null,
		defaultProvider,
		localCerts: first('local_certs') !== undefined,
		certsOff: autoHttps.includes('off') || autoHttps.includes('disable_certs')
	};
}

function siteCertificate(
	lines: readonly Directive[],
	g: Globals
): Pick<SiteFacts, 'certificate' | 'onDemand' | 'dns01'> {
	let certificate: SiteFacts['certificate'] = g.localCerts ? 'internal' : 'acme';
	let onDemand = false;
	let dns01: Dns01 | null = null;
	let explicit = false;
	for (const tls of lines) {
		const [a, b] = tls.args.map((t) => t.text);
		if (a === 'internal') certificate = 'internal';
		else if (a !== undefined && b !== undefined) certificate = 'files';
		else if (a !== undefined) certificate = 'acme'; // an email or force_automate
		if (a !== undefined) explicit = true;
		const body = tls.body ?? [];
		if (directives(body, 'on_demand').length) onDemand = true;
		const issuer = directives(body, 'issuer')[0];
		if (issuer?.args[0]?.text === 'internal') certificate = 'internal';
		if (issuer?.args[0]?.text === 'acme' || issuer?.args[0]?.text === 'zerossl') certificate = 'acme';
		const dns = directives(body, 'dns')[0] ?? (issuer ? directives(issuer.body ?? [], 'dns')[0] : undefined);
		if (dns) dns01 = { source: 'site', provider: dns.args[0]?.text ?? g.defaultProvider };
	}
	// `auto_https off` only stops the certificates Caddy would get by itself; a site's own tls line still counts.
	if (g.certsOff && !explicit && !dns01) certificate = 'off';
	if (certificate !== 'acme') return { certificate, onDemand, dns01: null };
	if (!dns01 && g.acmeDns) dns01 = { source: 'global', provider: g.acmeDns.provider };
	return { certificate, onDemand, dns01 };
}

export function readCaddyfile(text: string): CaddyfileFacts {
	const { file } = parse(text);
	const snippets = new Map<string, Node[]>();
	let globals: Globals = { acmeDns: null, defaultProvider: null, localCerts: false, certsOff: false };
	for (const block of file.blocks) {
		if (block.kind === 'snippet') snippets.set(block.name, block.body);
		else if (block.kind === 'global') globals = readGlobals(block.body);
	}
	const sites: SiteFacts[] = [];
	for (const block of file.blocks) {
		if (block.kind !== 'site') continue;
		const addresses = block.addresses
			.flatMap((t) => t.text.split(','))
			.map((a) => a.trim())
			.filter(Boolean);
		if (addresses.length === 0) continue;
		const first = block.addresses[0];
		sites.push({
			id: siteId(addresses),
			addresses,
			line: first?.span ? positionAt(text, first.span.start).line : 1,
			hosts: addresses.flatMap((a) => siteHost(a) ?? []),
			...siteCertificate(tlsLines(block.body, snippets), globals)
		});
	}
	return { sites, globalDns01: globals.acmeDns };
}
