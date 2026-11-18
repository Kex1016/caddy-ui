import type { DnsRecord } from '$lib/api/porkbun';
import { fqdn, isIPv4 } from './names';

/**
 * Which records Caddy depends on (docs/porkbun-plan.md §3.1 rule 6):
 *
 * - `_acme-challenge` TXT records are "managed by Caddy": the DNS-01 challenge creates and deletes them.
 * - A, AAAA, CNAME and ALIAS records a site's address resolves through are "used by site", so that editing or
 *   deleting one says which sites it takes with it.
 *
 * Worked out from the Caddyfile's site addresses and the zone alone, so the DNS tab does not need the Caddy
 * tie-in (workstream P5) to be there. When `GET /api/porkbun/caddy` answers with a cross-check this page can
 * read, `marksFromCaddy` takes the site-to-record pairs from it instead.
 */

/** A site of the Caddyfile whose address is a name in this domain. */
export type SiteUse = {
	/** The address as a hostname: `blog.example.com`, `*.example.com`. */
	host: string;
	/** Where the site is edited, when known. */
	href: string | null;
	/** True when the site block is switched off in the Caddyfile. */
	disabled: boolean;
};

export type RecordMarks = {
	managedByCaddy: boolean;
	sites: SiteUse[];
};

/** Record id to its marks. Records without a mark are absent. */
export type MarkMap = Record<string, RecordMarks>;

const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'ALIAS']);
const POINTER_TYPES = new Set(['CNAME', 'ALIAS']);
const MAX_HOPS = 8;

const inDomain = (name: string, domain: string) => name === domain || name.endsWith('.' + domain);

/**
 * A Caddy site address as a hostname, or null for one that names no host: `:8080`, `localhost`, an IP, an
 * address with a placeholder. `https://app.example.com:8443/api/*` is `app.example.com`.
 */
export function siteHostOf(address: string): string | null {
	let a = address.trim().toLowerCase();
	a = a.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
	a = a.split('/')[0] ?? '';
	if (a.startsWith('[') || a.includes('{')) return null;
	a = a.replace(/:\d*$/, '').replace(/\.$/, '');
	if (a === '' || !a.includes('.') || a.includes(':') || isIPv4(a)) return null;
	return a;
}

/** The sites of a Caddyfile that live under `domain`, one entry per address. */
export function sitesInDomain(
	blocks: readonly { id: string | null; addresses: readonly string[]; disabled: boolean }[],
	domain: string
): SiteUse[] {
	const out: SiteUse[] = [];
	const seen = new Set<string>();
	for (const block of blocks) {
		for (const address of block.addresses) {
			const host = siteHostOf(address);
			if (!host || !inDomain(host, domain) || seen.has(host)) continue;
			seen.add(host);
			out.push({
				host,
				href: block.id ? `/sites/${encodeURIComponent(block.id)}` : null,
				disabled: block.disabled
			});
		}
	}
	return out;
}

/** A DNS-01 challenge record: `_acme-challenge` or `_acme-challenge.<sub>`, type TXT. */
export function isAcmeChallenge(record: Pick<DnsRecord, 'host' | 'type'>): boolean {
	return (
		record.type === 'TXT' && (record.host === '_acme-challenge' || record.host.startsWith('_acme-challenge.'))
	);
}

/**
 * The records `name` is answered from: the address records at the name itself, else those of the wildcard
 * that covers it, and whatever those point at inside the same zone.
 */
export function recordsBehind(name: string, records: readonly DnsRecord[], domain: string): DnsRecord[] {
	const byName = new Map<string, DnsRecord[]>();
	for (const r of records) {
		const key = fqdn(r.host, domain);
		byName.set(key, [...(byName.get(key) ?? []), r]);
	}
	const exists = (node: string) =>
		node === domain || [...byName.keys()].some((n) => n === node || n.endsWith('.' + node));

	const answering = (wanted: string): DnsRecord[] => {
		const exact = byName.get(wanted);
		if (exact) return exact.filter((r) => ADDRESS_TYPES.has(r.type));
		// A wildcard answers only from the closest name above that exists at all (RFC 4592).
		const labels = wanted.split('.');
		for (let i = 1; i < labels.length; i++) {
			const parent = labels.slice(i).join('.');
			if (!inDomain(parent, domain)) break;
			if (!exists(parent)) continue;
			return (byName.get(`*.${parent}`) ?? []).filter((r) => ADDRESS_TYPES.has(r.type));
		}
		return [];
	};

	const found = new Map<string, DnsRecord>();
	const visited = new Set<string>();
	let frontier = [name.toLowerCase()];
	for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const wanted of frontier) {
			if (visited.has(wanted)) continue;
			visited.add(wanted);
			for (const r of answering(wanted)) {
				found.set(r.id, r);
				if (!POINTER_TYPES.has(r.type)) continue;
				const target = r.content.trim().toLowerCase().replace(/\.$/, '');
				if (inDomain(target, domain)) next.push(target);
			}
		}
		frontier = next;
	}
	return [...found.values()];
}

/** The marks of every record of a zone, from the sites of the Caddyfile. */
export function markRecords(
	records: readonly DnsRecord[],
	sites: readonly SiteUse[],
	domain: string
): MarkMap {
	const marks: MarkMap = {};
	const of = (id: string) => (marks[id] ??= { managedByCaddy: false, sites: [] });
	for (const r of records) if (isAcmeChallenge(r)) of(r.id).managedByCaddy = true;
	for (const site of sites) {
		for (const r of recordsBehind(site.host, records, domain)) of(r.id).sites.push(site);
	}
	return marks;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The same marks from the Caddy tie-in's cross-check, when it is there and has the shape this page reads:
 * `{ sites: [{ host, records: [{ id }] }] }`. Anything else is null, and the marks worked out here are used.
 * Sites the tie-in does not list keep what `known` says about them (their link, whether they are off).
 */
export function marksFromCaddy(
	payload: unknown,
	records: readonly DnsRecord[],
	known: readonly SiteUse[],
	domain: string
): MarkMap | null {
	if (!isObj(payload) || !Array.isArray(payload.sites)) return null;
	const ids = new Set(records.map((r) => r.id));
	const marks: MarkMap = {};
	const of = (id: string) => (marks[id] ??= { managedByCaddy: false, sites: [] });
	for (const r of records) if (isAcmeChallenge(r)) of(r.id).managedByCaddy = true;
	for (const entry of payload.sites) {
		if (!isObj(entry) || typeof entry.host !== 'string' || !Array.isArray(entry.records)) return null;
		const host = siteHostOf(entry.host);
		if (!host || !inDomain(host, domain)) continue;
		const site = known.find((s) => s.host === host) ?? { host, href: null, disabled: false };
		for (const ref of entry.records) {
			const id =
				isObj(ref) && (typeof ref.id === 'string' || typeof ref.id === 'number') ? String(ref.id) : '';
			if (ids.has(id) && !of(id).sites.some((s) => s.host === host)) of(id).sites.push(site);
		}
	}
	return marks;
}

/** One sentence for a review: what depends on a record that is about to change or go. */
export function dependents(marks: RecordMarks | undefined, op: 'edit' | 'delete'): string | null {
	if (!marks) return null;
	const parts: string[] = [];
	if (marks.sites.length > 0) {
		const names = marks.sites.map((s) => s.host);
		const list =
			names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
		parts.push(
			`Used by the site${names.length === 1 ? '' : 's'} ${list}: ${op === 'delete' ? 'without this record' : 'with a wrong value here'} ${names.length === 1 ? 'it' : 'they'} can not be reached.`
		);
	}
	if (marks.managedByCaddy) {
		parts.push(
			'Managed by Caddy: it creates and removes this record itself while it gets a certificate. Leave it alone unless it is a leftover.'
		);
	}
	return parts.length > 0 ? parts.join(' ') : null;
}
