import { isIPv4, isIPv6 } from 'node:net';
import type { DnsRecord } from '$lib/api/porkbun';

/**
 * What a name resolves to according to the records at Porkbun: exact records first, then the wildcard of
 * the closest enclosing name, following CNAME and ALIAS records while they stay inside the account's
 * domains. Nothing here asks a resolver; it reads the zones the way a nameserver would answer from them.
 */
export type ZoneRecord = DnsRecord & { domain: string };

export type Resolution = {
	/** Every record walked, in order: CNAMEs first, then the address records they end at. */
	chain: ZoneRecord[];
	/** The address records the name ends at. */
	addresses: ZoneRecord[];
	/** Set when a CNAME or ALIAS points at a name outside the account's domains. */
	external: string | null;
	/** The answer came from a `*` record, not from a record of the name itself. */
	viaWildcard: boolean;
	/** The name itself, or something on the way, is a CNAME or ALIAS. */
	viaAlias: boolean;
	/** A domain on the way whose zone could not be read. */
	unreadable: string | null;
};

const ADDRESS_TYPES = new Set(['A', 'AAAA']);
const ALIAS_TYPES = new Set(['CNAME', 'ALIAS']);
const MAX_HOPS = 8;

export const fqdn = (name: string): string => name.trim().toLowerCase().replace(/\.$/, '');

/** The account domain a name is under (the longest one), or null. */
export function domainOf(name: string, domains: readonly string[]): string | null {
	const host = fqdn(name).replace(/^\*\./, '');
	let best: string | null = null;
	for (const d of domains) {
		if ((host === d || host.endsWith('.' + d)) && (best === null || d.length > best.length)) best = d;
	}
	return best;
}

/** The part of a name before its domain: `app`, `*`, or '' for the apex. */
export function hostLabel(name: string, domain: string): string {
	const n = fqdn(name);
	return n === domain ? '' : n.slice(0, -(domain.length + 1));
}

/** The records that answer for `name` in one zone, and whether a wildcard supplied them. */
export function answersFor(
	name: string,
	domain: string,
	records: readonly DnsRecord[]
): { records: DnsRecord[]; viaWildcard: boolean } {
	const wanted = (r: DnsRecord) => ADDRESS_TYPES.has(r.type) || ALIAS_TYPES.has(r.type);
	const exact = records.filter((r) => r.name === name && wanted(r));
	if (exact.length > 0) return { records: exact, viaWildcard: false };
	// A name that exists (it has other records, or names below it) is never answered by a wildcard.
	const exists = (n: string) => n === domain || records.some((r) => r.name === n || r.name.endsWith('.' + n));
	if (exists(name)) return { records: [], viaWildcard: false };
	const labels = name.split('.');
	for (let i = 1; i < labels.length; i++) {
		const ancestor = labels.slice(i).join('.');
		if (ancestor.length < domain.length) break;
		if (!exists(ancestor)) continue;
		// The closest enclosing name that exists: only its wildcard can answer.
		const wild = records.filter((r) => r.name === `*.${ancestor}` && wanted(r));
		return { records: wild, viaWildcard: wild.length > 0 };
	}
	return { records: [], viaWildcard: false };
}

/**
 * Resolve `name` through the account's zones. `zoneOf` returns a domain's records, or null when they can not
 * be read; it is asked at most once per domain by the caller's own caching.
 */
export async function resolveName(
	name: string,
	domains: readonly string[],
	zoneOf: (domain: string) => Promise<readonly DnsRecord[] | null>
): Promise<Resolution> {
	const out: Resolution = {
		chain: [],
		addresses: [],
		external: null,
		viaWildcard: false,
		viaAlias: false,
		unreadable: null
	};
	const seen = new Set<string>();
	let current = fqdn(name);
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		if (seen.has(current)) break; // a CNAME loop resolves to nothing
		seen.add(current);
		const domain = domainOf(current, domains);
		if (domain === null) {
			if (hop > 0) out.external = current;
			break;
		}
		const records = await zoneOf(domain);
		if (records === null) {
			out.unreadable = domain;
			break;
		}
		const answer = answersFor(current, domain, records);
		if (hop === 0) out.viaWildcard = answer.viaWildcard;
		const alias = answer.records.find((r) => ALIAS_TYPES.has(r.type));
		if (alias) {
			out.chain.push({ ...alias, domain });
			out.viaAlias = true;
			current = fqdn(alias.content);
			continue;
		}
		out.addresses = answer.records.map((r) => ({ ...r, domain }));
		out.chain.push(...out.addresses);
		break;
	}
	return out;
}

/** An IP address in one spelling, so two ways of writing the same IPv6 address compare equal. */
export function canonicalIp(ip: string): string {
	const value = ip.trim().toLowerCase();
	if (!isIPv6(value)) return value;
	let [head = '', tail] = value.split('::') as [string, string | undefined];
	// An embedded IPv4 tail (::ffff:192.0.2.1) becomes two groups.
	const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(tail ?? head);
	if (v4) {
		const hex = [
			((Number(v4[1]) << 8) | Number(v4[2])).toString(16),
			((Number(v4[3]) << 8) | Number(v4[4])).toString(16)
		].join(':');
		if (tail !== undefined) tail = tail.replace(v4[0], hex);
		else head = head.replace(v4[0], hex);
	}
	const left = head === '' ? [] : head.split(':');
	const right = tail === undefined || tail === '' ? [] : tail.split(':');
	const fill = tail === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
	return [...left, ...fill, ...right].map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}

export const sameIp = (a: string, b: string): boolean => canonicalIp(a) === canonicalIp(b);

export const ipFamily = (ip: string): 'A' | 'AAAA' | null => (isIPv4(ip) ? 'A' : isIPv6(ip) ? 'AAAA' : null);

/** Addresses that are only reachable inside a network: RFC 1918, loopback, link-local, CGNAT, IPv6 ULA. */
export function isPrivateIp(ip: string): boolean {
	if (isIPv4(ip)) {
		const [a = 0, b = 0] = ip.split('.').map(Number);
		return (
			a === 10 ||
			a === 127 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	if (isIPv6(ip)) {
		const first = parseInt(canonicalIp(ip).split(':')[0] ?? '0', 16);
		return (
			canonicalIp(ip) === '0:0:0:0:0:0:0:1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
		);
	}
	return false;
}
