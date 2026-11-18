import { PORKBUN_NAMESERVERS, type DnssecInput } from '$lib/api/porkbun';

/**
 * Input checks for the Registry tab (nameservers, glue, DNSSEC), shared by the forms and the
 * `/api/porkbun/domains/:d/{nameservers,glue,dnssec}` routes (workstream P3). Client-safe: no Node imports.
 * Everything a route sends to Porkbun has passed through one of these first, so a malformed value is refused
 * with a 400 before any call is made.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)(${LABEL}\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`);
const SUBDOMAIN = new RegExp(`^(?=.{1,190}$)${LABEL}(\\.${LABEL})*$`);

/** Lower case, no surrounding spaces, no trailing dot. */
export function normalizeHost(name: string): string {
	return name.trim().toLowerCase().replace(/\.$/, '');
}

/** Split a pasted list on commas, semicolons and any whitespace, dropping empties. */
export function splitList(text: string | readonly string[]): string[] {
	const parts = typeof text === 'string' ? text.split(/[\s,;]+/) : text.flatMap((t) => t.split(/[\s,;]+/));
	return parts.map((p) => p.trim()).filter(Boolean);
}

export function isHostname(name: string): boolean {
	return HOSTNAME.test(name);
}

/** Registries accept between 2 and 13 nameservers. */
export const NS_MIN = 2;
export const NS_MAX = 13;

/** A nameserver set as Porkbun's `/domain/updateNs` takes it: 2 to 13 distinct hostnames. */
export function checkNameservers(input: unknown): Checked<string[]> {
	if (typeof input !== 'string' && !(Array.isArray(input) && input.every((n) => typeof n === 'string'))) {
		return { ok: false, message: 'Send the nameservers as a list of hostnames' };
	}
	const ns = splitList(input as string | string[]).map(normalizeHost);
	const bad = ns.filter((n) => !isHostname(n));
	if (bad.length > 0) {
		return { ok: false, message: `Not a hostname: ${bad.slice(0, 3).join(', ')}` };
	}
	const unique = [...new Set(ns)];
	if (unique.length !== ns.length) return { ok: false, message: 'A nameserver is listed twice' };
	if (unique.length < NS_MIN) return { ok: false, message: `Give at least ${NS_MIN} nameservers` };
	if (unique.length > NS_MAX) return { ok: false, message: `Give at most ${NS_MAX} nameservers` };
	return { ok: true, value: unique };
}

/** Whether two nameserver lists are the same set, ignoring order, case and trailing dots. */
export function sameNameservers(a: readonly string[], b: readonly string[]): boolean {
	const x = new Set(a.map(normalizeHost));
	const y = new Set(b.map(normalizeHost));
	return x.size === y.size && [...x].every((n) => y.has(n));
}

export function isPorkbunDefault(ns: readonly string[]): boolean {
	return sameNameservers(ns, PORKBUN_NAMESERVERS);
}

/** Every nameserver is one of Porkbun's (`*.ns.porkbun.com`). */
export function isAtPorkbun(ns: readonly string[]): boolean {
	return ns.length > 0 && ns.every((n) => normalizeHost(n).endsWith('.ns.porkbun.com'));
}

/**
 * The host part of a glue record, as Porkbun's glue endpoints take it in the path: `ns1` for
 * `ns1.example.com`. Accepts either form. A glue record is always a name inside the domain itself.
 */
export function checkGlueHost(input: unknown, domain: string): Checked<string> {
	if (typeof input !== 'string' || input.trim() === '') {
		return { ok: false, message: 'Give the nameserver host, for example ns1' };
	}
	let host = normalizeHost(input);
	const suffix = `.${domain}`;
	if (host === domain) return { ok: false, message: `The host must be a name under ${domain}, like ns1` };
	if (host.endsWith(suffix)) host = host.slice(0, -suffix.length);
	else if (host.includes('.')) {
		// "ns1.other.test" could mean a name elsewhere; a name with dots must be spelled out in full.
		return { ok: false, message: `A glue host is a name under ${domain}: write ns1 or ns1.${domain}` };
	}
	if (!SUBDOMAIN.test(host)) {
		return { ok: false, message: `Not a valid host name under ${domain}: ${input.trim()}` };
	}
	return { ok: true, value: host };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(ip: string): boolean {
	return IPV4.test(ip);
}

export function isIPv6(ip: string): boolean {
	if (!/^[0-9a-f:.]+$/i.test(ip) || ip.length > 45) return false;
	let text = ip;
	let groups = 8;
	// An IPv4 tail (::ffff:192.0.2.1) takes the room of two groups.
	const lastColon = text.lastIndexOf(':');
	if (text.includes('.')) {
		if (!isIPv4(text.slice(lastColon + 1))) return false;
		text = text.slice(0, lastColon + 1) + '0';
		groups = 7;
	}
	const halves = text.split('::');
	if (halves.length > 2) return false;
	const part = (s: string) => (s === '' ? [] : s.split(':'));
	const head = part(halves[0] ?? '');
	const tail = halves.length === 2 ? part(halves[1] ?? '') : [];
	if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
	const count = head.length + tail.length;
	return halves.length === 2 ? count < groups : count === groups;
}

export const GLUE_MAX_IPS = 13;

/** The addresses of a glue host: at least one, IPv4 or IPv6, no duplicates. */
export function checkGlueIps(input: unknown): Checked<string[]> {
	if (typeof input !== 'string' && !(Array.isArray(input) && input.every((n) => typeof n === 'string'))) {
		return { ok: false, message: 'Send the addresses as a list' };
	}
	const ips = splitList(input as string | string[]).map((i) => i.toLowerCase());
	if (ips.length === 0) return { ok: false, message: 'Give at least one IPv4 or IPv6 address' };
	const bad = ips.filter((i) => !isIPv4(i) && !isIPv6(i));
	if (bad.length > 0) return { ok: false, message: `Not an IP address: ${bad.slice(0, 3).join(', ')}` };
	const unique = [...new Set(ips)];
	if (unique.length !== ips.length) return { ok: false, message: 'An address is listed twice' };
	if (unique.length > GLUE_MAX_IPS) return { ok: false, message: `Give at most ${GLUE_MAX_IPS} addresses` };
	return { ok: true, value: unique };
}

// ── DNSSEC ───────────────────────────────────────────────────────────────────────────────────────────

/** DNSSEC algorithm numbers (IANA). The registry refuses the retired ones; 13 and 8 are the usual choice. */
export const DNSSEC_ALGORITHMS: Record<string, { name: string; retired?: boolean }> = {
	'1': { name: 'RSA/MD5', retired: true },
	'3': { name: 'DSA/SHA-1', retired: true },
	'5': { name: 'RSA/SHA-1', retired: true },
	'6': { name: 'DSA-NSEC3-SHA1', retired: true },
	'7': { name: 'RSASHA1-NSEC3-SHA1', retired: true },
	'8': { name: 'RSA/SHA-256' },
	'10': { name: 'RSA/SHA-512' },
	'12': { name: 'GOST R 34.10-2001', retired: true },
	'13': { name: 'ECDSA P-256/SHA-256' },
	'14': { name: 'ECDSA P-384/SHA-384' },
	'15': { name: 'Ed25519' },
	'16': { name: 'Ed448' }
};

/** DS digest types and the length of their hex digest. */
export const DS_DIGEST_TYPES: Record<string, { name: string; hexLength: number; retiring?: boolean }> = {
	'1': { name: 'SHA-1', hexLength: 40, retiring: true },
	'2': { name: 'SHA-256', hexLength: 64 },
	'4': { name: 'SHA-384', hexLength: 96 }
};

export function algorithmName(alg: string): string {
	return DNSSEC_ALGORITHMS[alg]?.name ?? `algorithm ${alg}`;
}

export function digestTypeName(type: string): string {
	return DS_DIGEST_TYPES[type]?.name ?? `digest type ${type}`;
}

export type DnssecFieldErrors = Partial<Record<keyof DnssecInput, string>>;

const field = (v: unknown): string =>
	typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
const inRange = (v: string, lo: number, hi: number) =>
	/^\d{1,5}$/.test(v) && Number(v) >= lo && Number(v) <= hi;

/**
 * A DS record for `/dns/createDnssecRecord`. The four DS fields are required; the key data fields are optional
 * but go together (some registries want the DNSKEY as well). Returns every problem at once, per field.
 */
export function checkDnssec(
	input: unknown
): { ok: true; value: DnssecInput } | { ok: false; message: string; fields: DnssecFieldErrors } {
	const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	const fields: DnssecFieldErrors = {};
	const keyTag = field(raw.keyTag);
	const alg = field(raw.alg);
	const digestType = field(raw.digestType);
	const digest = field(raw.digest).replace(/\s+/g, '').toUpperCase();

	if (!inRange(keyTag, 0, 65535)) fields.keyTag = 'A whole number from 0 to 65535';
	if (!inRange(alg, 1, 255)) fields.alg = 'An algorithm number, for example 13';
	else if (DNSSEC_ALGORITHMS[alg]?.retired)
		fields.alg = `${algorithmName(alg)} is retired; registries refuse it. Use 13 or 8`;
	if (!inRange(digestType, 1, 255)) fields.digestType = 'A digest type number, for example 2';
	if (!/^[0-9A-F]+$/.test(digest)) fields.digest = 'The digest in hexadecimal';
	else {
		const expected = DS_DIGEST_TYPES[digestType]?.hexLength;
		if (expected && digest.length !== expected)
			fields.digest = `A ${digestTypeName(digestType)} digest is ${expected} hex characters; this one has ${digest.length}`;
	}

	const value: DnssecInput = { keyTag, alg, digestType, digest };
	const maxSigLife = field(raw.maxSigLife);
	if (maxSigLife !== '') {
		if (!/^\d{1,10}$/.test(maxSigLife)) fields.maxSigLife = 'Seconds, as a whole number';
		else value.maxSigLife = maxSigLife;
	}
	const flags = field(raw.keyDataFlags);
	const protocol = field(raw.keyDataProtocol);
	const algo = field(raw.keyDataAlgo);
	const pubKey = field(raw.keyDataPubKey).replace(/\s+/g, '');
	if (flags || protocol || algo || pubKey) {
		if (!inRange(flags, 0, 65535)) fields.keyDataFlags = 'The DNSKEY flags, usually 257';
		if (protocol !== '3') fields.keyDataProtocol = 'The DNSKEY protocol is always 3';
		if (!inRange(algo, 1, 255)) fields.keyDataAlgo = 'The DNSKEY algorithm number';
		if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pubKey)) fields.keyDataPubKey = 'The public key in base64';
		Object.assign(value, {
			keyDataFlags: flags,
			keyDataProtocol: protocol,
			keyDataAlgo: algo,
			keyDataPubKey: pubKey
		});
	}

	const problems = Object.values(fields);
	if (problems.length > 0) return { ok: false, message: problems.join('; '), fields };
	return { ok: true, value };
}

/**
 * Read a DS record as DNS providers print it, to fill the form: `2371 13 2 49FD…`, optionally after
 * `example.com. 3600 IN DS`. Returns null when the text is not one.
 */
export function parseDsText(
	text: string
): Pick<DnssecInput, 'keyTag' | 'alg' | 'digestType' | 'digest'> | null {
	const tokens = text.trim().split(/\s+/);
	const at = tokens.findIndex((t) => t.toUpperCase() === 'DS');
	const rest = at >= 0 ? tokens.slice(at + 1) : tokens;
	if (rest.length < 4) return null;
	const [keyTag, alg, digestType, ...digestParts] = rest as [string, string, string, ...string[]];
	if (![keyTag, alg, digestType].every((n) => /^\d{1,5}$/.test(n))) return null;
	const digest = digestParts.join('').toUpperCase();
	if (!/^[0-9A-F]+$/.test(digest)) return null;
	return { keyTag, alg, digestType, digest };
}

/** The value the typed confirmation compares with: the domain, as `TypedConfirm` compares it. */
export function confirms(typed: unknown, domain: string): boolean {
	return typeof typed === 'string' && typed.trim().toLowerCase() === domain.toLowerCase();
}
