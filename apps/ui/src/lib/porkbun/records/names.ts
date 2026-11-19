/**
 * Names and addresses as DNS records use them. Client-safe and pure: the same checks run in the record form
 * and in the `/api/porkbun/domains/:d/dns` routes, so nothing a form accepts is refused by the route for a
 * reason the form could have given.
 */

export function isIPv4(text: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (!m) return false;
	// A leading zero is refused: some resolvers read "010" as octal.
	return m.slice(1).every((part) => (part === '0' || !part.startsWith('0')) && Number(part) <= 255);
}

export function isIPv6(text: string): boolean {
	if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(':')) return false;
	const halves = text.split('::');
	if (halves.length > 2) return false;
	const split = (side: string) => (side === '' ? [] : side.split(':'));
	const head = split(halves[0] as string);
	const tail = halves.length === 2 ? split(halves[1] as string) : [];
	const groups = [...head, ...tail];
	let count = groups.length;
	const last = groups[groups.length - 1];
	if (last !== undefined && last.includes('.')) {
		// An IPv4 address may stand in for the last 32 bits.
		if (halves.length === 2 && tail.length === 0) return false;
		if (!isIPv4(last)) return false;
		groups.pop();
		count += 1;
	}
	if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
	return halves.length === 2 ? count <= 7 : count === 8;
}

/** One label of a name. Underscores are allowed: `_dmarc`, `_sip._tcp`, validation targets of CAs. */
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** `www.example.com`: the full name of a record. `host` is '' for the apex. */
export function fqdn(host: string, domain: string): string {
	return host === '' ? domain : `${host}.${domain}`;
}

/**
 * What a person typed as a record's name, as the part before the domain: '' for the apex. Accepts '@', a
 * trailing dot and the full name (`www.example.com` under example.com becomes `www`), as Porkbun's own import
 * does.
 */
export function normaliseHost(raw: string, domain: string): string {
	let host = raw.trim().toLowerCase().replace(/\.$/, '');
	const d = domain.toLowerCase();
	if (host === '@' || host === d) return '';
	if (host.endsWith('.' + d)) host = host.slice(0, -(d.length + 1));
	return host;
}

/** Why `host` (already normalised) can not be a record name under `domain`, or null. */
export function hostProblem(host: string, domain: string): string | null {
	if (host === '') return null;
	if (hasNonAscii(host)) return 'Use the ASCII form of an international name (it starts with xn--)';
	if (/\s/.test(host) || hasControlChar(host)) return 'A name can not contain spaces';
	const labels = host.split('.');
	if (labels.some((l) => l === '')) return 'A name can not have an empty part between two dots';
	for (const [i, label] of labels.entries()) {
		if (label === '*') {
			if (i !== 0) return 'A wildcard (*) can only be the first part of a name';
			continue;
		}
		if (label.length > 63) return 'Each part of a name can be at most 63 characters';
		if (!LABEL.test(label)) {
			return label.includes('*')
				? 'A wildcard is a part of its own: *.shop, not *shop'
				: `"${label}" is not usable in a name: use letters, digits, hyphens and underscores, and do not start or end with a hyphen`;
		}
	}
	if (fqdn(host, domain).length > 253) return 'The full name is longer than 253 characters';
	return null;
}

/** A hostname a record points at, as typed: lower case, without the trailing dot. */
export function normaliseTarget(raw: string): string {
	const text = raw.trim().toLowerCase();
	return text === '.' ? text : text.replace(/\.$/, '');
}

/**
 * Why `target` (already normalised) can not be the hostname a record points at, or null. A target is always a
 * full name here: Porkbun does not complete `mail` to `mail.example.com`.
 */
export function targetProblem(target: string, opts: { allowRoot?: boolean } = {}): string | null {
	if (target === '') return 'Enter a hostname';
	if (target === '.') return opts.allowRoot ? null : 'Enter a hostname';
	if (isIPv4(target) || isIPv6(target)) return 'This needs a hostname, not an IP address';
	if (hasNonAscii(target)) return 'Use the ASCII form of an international name (it starts with xn--)';
	if (/\s/.test(target)) return 'A hostname can not contain spaces';
	if (target.length > 253) return 'A hostname can be at most 253 characters';
	const labels = target.split('.');
	if (labels.length < 2) {
		return 'Enter the full hostname, for example mail.example.com: a short name is not completed with the domain';
	}
	for (const label of labels) {
		if (label === '') return 'A hostname can not have an empty part between two dots';
		if (label.length > 63) return 'Each part of a hostname can be at most 63 characters';
		if (!LABEL.test(label)) return `"${label}" is not usable in a hostname`;
	}
	return null;
}

/** Whole number within bounds, written in plain digits. null for anything else. */
export function wholeNumber(text: string, min: number, max: number): number | null {
	const t = text.trim();
	if (!/^\d{1,10}$/.test(t)) return null;
	const n = Number(t);
	return n >= min && n <= max ? n : null;
}

/** Hex as pasted (spaces and colons between bytes are common), without the separators, lower case. */
export function cleanHex(text: string): string {
	return text.replace(/[\s:]/g, '').toLowerCase();
}

export function isHex(text: string): boolean {
	return text.length > 0 && text.length % 2 === 0 && /^[0-9a-f]+$/.test(text);
}

export function hasNonAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7e) return true;
	return false;
}

export function hasControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}
