import type { DnsRecord } from '$lib/api/porkbun';
import { RECORD_KINDS, typeRank } from './kinds';
import { cleanHex, normaliseHost } from './names';
import type { ImportCandidate } from './types';

/**
 * Zone files (RFC 1035 master format, as BIND and most DNS hosts read and write it) and the JSON list, both
 * ways: `toZoneFile` / `toJsonExport` write the records of the DNS tab, `parseImportText` reads what a person
 * pastes. Pure and client-safe.
 *
 * Porkbun keeps a record's value in its own spelling: hostnames without the trailing dot, the priority of MX
 * and SRV apart from the value, TXT without the quotes. The functions here translate between that and the
 * zone file spelling, so a file written here reads back as the same records.
 */

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────────────

const absolute = (name: string) => (name === '.' || name.endsWith('.') ? name : `${name}.`);

/** A TXT value as quoted strings of at most 255 bytes each, with everything outside printable ASCII escaped. */
export function quoteTxt(content: string): string {
	const bytes = new TextEncoder().encode(content);
	if (bytes.length === 0) return '""';
	const chunks: string[] = [];
	for (let at = 0; at < bytes.length; at += 255) {
		let out = '';
		for (const b of bytes.subarray(at, at + 255)) {
			if (b === 0x22 || b === 0x5c) out += '\\' + String.fromCharCode(b);
			else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
			else out += '\\' + String(b).padStart(3, '0');
		}
		chunks.push(`"${out}"`);
	}
	return chunks.join(' ');
}

/** A record's value as the right-hand side of a zone file line. */
export function rdataOf(r: Pick<DnsRecord, 'type' | 'content' | 'prio'>): string {
	const content = r.content.trim();
	switch (r.type) {
		case 'CNAME':
		case 'ALIAS':
		case 'NS':
			return absolute(content);
		case 'MX':
			return `${r.prio ?? 0} ${absolute(content)}`;
		case 'SRV': {
			const m = /^(\d+)\s+(\d+)\s+(\S+)$/.exec(content);
			return m ? `${r.prio ?? 0} ${m[1]} ${m[2]} ${absolute(m[3] as string)}` : `${r.prio ?? 0} ${content}`;
		}
		case 'TXT':
			return quoteTxt(r.content);
		case 'HTTPS':
		case 'SVCB': {
			const m = /^(\d+)\s+(\S+)(\s+.*)?$/.exec(content);
			return m ? `${m[1]} ${absolute(m[2] as string)}${m[3] ?? ''}` : content;
		}
		default:
			return content;
	}
}

/** Apex first, then names by their parts from the right, so a subdomain sits under its parent. */
export function hostKey(host: string): string {
	return host === '' ? '' : ' ' + host.split('.').reverse().join(' ');
}

export function compareRecords(
	a: Pick<DnsRecord, 'host' | 'type' | 'content' | 'prio'>,
	b: Pick<DnsRecord, 'host' | 'type' | 'content' | 'prio'>
): number {
	const ka = hostKey(a.host);
	const kb = hostKey(b.host);
	if (ka !== kb) return ka < kb ? -1 : 1;
	const rank = typeRank(a.type) - typeRank(b.type);
	if (rank !== 0) return rank;
	if (a.type !== b.type) return a.type < b.type ? -1 : 1;
	const prio = (a.prio ?? 0) - (b.prio ?? 0);
	if (prio !== 0) return prio;
	return a.content < b.content ? -1 : a.content > b.content ? 1 : 0;
}

/** Text on one line: line breaks and other control characters become spaces. */
function oneLine(text: string): string {
	let out = '';
	for (const ch of text) out += ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch;
	return out.replace(/ {2,}/g, ' ').trim();
}

export type ExportMeta = {
	/** When the records were read from Porkbun, ms since the epoch. */
	at: number;
	/** The records are the last good read, because Porkbun could not be asked. */
	stale?: boolean;
};

export function toZoneFile(domain: string, records: readonly DnsRecord[], meta: ExportMeta): string {
	const sorted = [...records].sort(compareRecords);
	const when = new Date(meta.at).toISOString().replace(/\.\d{3}Z$/, 'Z');
	const lines = [
		`; Zone file for ${domain}`,
		`; Records as Porkbun had them on ${when}, exported by Caddy UI.`,
		"; The SOA record and Porkbun's own NS records are not part of this file."
	];
	if (meta.stale)
		lines.push('; Porkbun could not be reached for this export: this is the last copy that was read.');
	if (sorted.some((r) => r.type === 'ALIAS')) {
		lines.push('; ALIAS is not a standard record type. Other DNS software may call it ANAME, or refuse it.');
	}
	lines.push(`$ORIGIN ${domain}.`, '$TTL 600');
	for (const r of sorted) {
		const fields = [r.host === '' ? '@' : r.host, String(r.ttl || 600), 'IN', r.type, rdataOf(r)];
		const note = r.notes ? oneLine(r.notes) : '';
		lines.push(fields.join('\t') + (note ? `\t; note: ${note}` : ''));
	}
	return lines.join('\n') + '\n';
}

export function toJsonExport(domain: string, records: readonly DnsRecord[], meta: ExportMeta): string {
	const sorted = [...records].sort(compareRecords);
	return (
		JSON.stringify(
			{
				domain,
				exportedAt: new Date(meta.at).toISOString(),
				...(meta.stale ? { stale: true } : {}),
				records: sorted.map((r) => ({
					name: r.host,
					type: r.type,
					content: r.content,
					ttl: r.ttl,
					prio: r.prio,
					notes: r.notes
				}))
			},
			null,
			2
		) + '\n'
	);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────

export type Unreadable = { line: number; message: string };

export type ParsedSource = {
	source: 'zone' | 'json';
	candidates: ImportCandidate[];
	unreadable: Unreadable[];
};

type Token = { text: string; quoted: boolean };
type Line = { no: number; blankOwner: boolean; tokens: Token[]; comment: string | null };

/**
 * Split zone file text into logical lines of tokens: comments dropped (the last one of a line is kept, for
 * notes), quoted strings kept whole, and parentheses joining physical lines.
 */
function lex(text: string): { lines: Line[]; unreadable: Unreadable[] } {
	const lines: Line[] = [];
	const unreadable: Unreadable[] = [];
	let no = 1;
	let depth = 0;
	// Held in an object so the closures below and the loop see the same value.
	const open: { line: Line | null } = { line: null };
	let fresh = true;
	let leadingSpace = false;
	let i = 0;

	const line = (): Line => {
		open.line ??= { no, blankOwner: leadingSpace, tokens: [], comment: null };
		return open.line;
	};
	const finish = () => {
		if (open.line && open.line.tokens.length > 0) lines.push(open.line);
		open.line = null;
	};
	const skipToNewline = () => {
		while (i < text.length && text[i] !== '\n') i++;
	};

	while (i < text.length) {
		const c = text[i] as string;
		if (c === '\n') {
			no++;
			i++;
			if (depth === 0) {
				finish();
				fresh = true;
				leadingSpace = false;
			}
			continue;
		}
		if (c === '\r') {
			i++;
			continue;
		}
		if (c === ' ' || c === '\t') {
			if (fresh && depth === 0) leadingSpace = true;
			fresh = false;
			i++;
			continue;
		}
		fresh = false;
		if (c === ';') {
			const start = i + 1;
			skipToNewline();
			if (open.line) open.line.comment = text.slice(start, i).replace(/\r$/, '').trim();
			continue;
		}
		if (c === '(') {
			line();
			depth++;
			i++;
			continue;
		}
		if (c === ')') {
			if (depth === 0) {
				unreadable.push({ line: no, message: 'A closing parenthesis without an opening one' });
				open.line = null;
				skipToNewline();
				continue;
			}
			depth--;
			i++;
			continue;
		}
		// A token: a quoted string, or a run of characters that may hold quoted parts (alpn="h3,h2").
		const startsQuoted = c === '"';
		let raw = '';
		let broken = false;
		let inQuote = false;
		while (i < text.length) {
			const ch = text[i] as string;
			if (ch === '\n') {
				if (inQuote) broken = true;
				break;
			}
			if (ch === '\\') {
				raw += ch + (text[i + 1] ?? '');
				i += 2;
				continue;
			}
			if (ch === '"') {
				inQuote = !inQuote;
				raw += ch;
				i++;
				if (!inQuote && startsQuoted) break;
				continue;
			}
			if (!inQuote && (ch === ' ' || ch === '\t' || ch === '\r' || ch === ';' || ch === '(' || ch === ')'))
				break;
			raw += ch;
			i++;
		}
		if (broken) {
			unreadable.push({ line: no, message: 'A quoted text is not closed on this line' });
			open.line = null;
			depth = 0;
			continue;
		}
		const l = line();
		l.tokens.push(startsQuoted ? { text: raw.slice(1, -1), quoted: true } : { text: raw, quoted: false });
	}
	finish();
	if (depth > 0) unreadable.push({ line: no, message: 'A parenthesis is opened but never closed' });
	return { lines, unreadable };
}

/** The bytes a token stands for: `\DDD` is one byte, `\X` is X, anything else is itself in UTF-8. */
function tokenBytes(raw: string): number[] {
	const out: number[] = [];
	const enc = new TextEncoder();
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i] as string;
		if (c === '\\') {
			const ddd = /^\d{3}/.exec(raw.slice(i + 1));
			if (ddd && Number(ddd[0]) <= 255) {
				out.push(Number(ddd[0]));
				i += 3;
			} else if (i + 1 < raw.length) {
				out.push(...enc.encode(raw[i + 1] as string));
				i += 1;
			}
			continue;
		}
		// A surrogate pair is one character.
		const code = raw.codePointAt(i) as number;
		const char = String.fromCodePoint(code);
		out.push(...enc.encode(char));
		i += char.length - 1;
	}
	return out;
}

const decode = (tokens: readonly Token[]): string =>
	new TextDecoder().decode(new Uint8Array(tokens.flatMap((t) => tokenBytes(t.text))));

/** "3600", "1h", "1h30m", "2d": seconds, or null. */
export function parseTtl(text: string): number | null {
	if (/^\d{1,10}$/.test(text)) return Number(text);
	if (!/^(\d+[wdhms])+$/i.test(text)) return null;
	const unit: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
	let total = 0;
	for (const m of text.toLowerCase().matchAll(/(\d+)([wdhms])/g))
		total += Number(m[1]) * (unit[m[2] as string] as number);
	return total;
}

const CLASSES = new Set(['IN', 'CH', 'HS', 'CS']);

export function parseZoneFile(text: string, domain: string): ParsedSource {
	const d = domain.toLowerCase();
	const { lines, unreadable } = lex(text);
	const candidates: ImportCandidate[] = [];
	let origin = d;
	let defaultTtl: number | undefined;
	let lastTtl: number | undefined;
	let lastOwner: string | undefined;

	/** A name of the file as a full name without the trailing dot. */
	const resolve = (name: string): string => {
		const n = name.toLowerCase();
		if (n === '@') return origin;
		if (n === '.') return '.';
		if (n.endsWith('.')) return n.slice(0, -1);
		return origin === '' ? n : `${n}.${origin}`;
	};

	for (const line of lines) {
		const fail = (message: string) => unreadable.push({ line: line.no, message });
		const tokens = [...line.tokens];
		const first = tokens[0] as Token;

		if (!line.blankOwner && !first.quoted && first.text.startsWith('$')) {
			const directive = first.text.toUpperCase();
			const arg = tokens[1]?.text;
			if (directive === '$ORIGIN' && arg) origin = resolve(arg) === '.' ? '' : resolve(arg);
			else if (directive === '$TTL' && arg && parseTtl(arg) !== null) defaultTtl = parseTtl(arg) as number;
			else if (directive === '$INCLUDE' || directive === '$GENERATE') {
				fail(`${directive} is not supported: paste the records it stands for instead`);
			} else fail(`"${first.text}" could not be read`);
			continue;
		}

		let owner: string;
		if (line.blankOwner) {
			if (lastOwner === undefined) {
				fail(
					'This line starts with a space, which means "same name as the line above", but no line above has a name'
				);
				continue;
			}
			owner = lastOwner;
		} else {
			owner = resolve((tokens.shift() as Token).text);
			lastOwner = owner;
		}

		let ttl: number | undefined;
		let cls: string | undefined;
		for (let n = 0; n < 2 && tokens.length > 1; n++) {
			const t = tokens[0] as Token;
			if (t.quoted) break;
			if (cls === undefined && CLASSES.has(t.text.toUpperCase())) cls = t.text.toUpperCase();
			else if (ttl === undefined && /^\d/.test(t.text) && parseTtl(t.text) !== null)
				ttl = parseTtl(t.text) as number;
			else break;
			tokens.shift();
		}
		const typeToken = tokens.shift();
		if (!typeToken || typeToken.quoted) {
			fail('No record type on this line');
			continue;
		}
		if (ttl !== undefined) lastTtl = ttl;
		if (cls !== undefined && cls !== 'IN') {
			fail(`Class ${cls} is not Internet DNS, so the record was left out`);
			continue;
		}
		let type = typeToken.text.toUpperCase();
		if (type === 'ANAME') type = 'ALIAS';

		let host: string;
		if (owner === d) host = '';
		else if (owner.endsWith('.' + d)) host = owner.slice(0, -(d.length + 1));
		else {
			fail(`${owner || 'The root'} is not under ${d}, so the record was left out`);
			continue;
		}

		const words = tokens.map((t) => t.text);
		const numbers = (n: number) => words.slice(0, n).every((w, i) => !tokens[i]?.quoted && /^\d+$/.test(w));
		const target = (i: number) => resolve(words[i] as string);
		let content: string;
		let prio: number | undefined;

		switch (type) {
			case 'A':
			case 'AAAA':
				if (words.length !== 1) {
					fail(`${type} takes one address`);
					continue;
				}
				content = words[0] as string;
				break;
			case 'CNAME':
			case 'ALIAS':
			case 'NS':
				if (words.length !== 1) {
					fail(`${type} takes one hostname`);
					continue;
				}
				content = target(0);
				break;
			case 'MX':
				if (words.length !== 2 || !numbers(1)) {
					fail('MX takes a priority and a mail server');
					continue;
				}
				prio = Number(words[0]);
				content = target(1);
				break;
			case 'SRV':
				if (words.length !== 4 || !numbers(3)) {
					fail('SRV takes a priority, a weight, a port and a target');
					continue;
				}
				prio = Number(words[0]);
				content = `${words[1]} ${words[2]} ${target(3)}`;
				break;
			case 'TXT':
				if (tokens.length === 0) {
					fail('TXT takes a text');
					continue;
				}
				content = decode(tokens);
				break;
			case 'CAA':
				if (words.length !== 3 || !numbers(1)) {
					fail('CAA takes flags, a tag and a value');
					continue;
				}
				content = RECORD_KINDS.CAA.join({
					flags: words[0] as string,
					tag: words[1] as string,
					value: decode([tokens[2] as Token])
				}).content;
				break;
			case 'TLSA':
			case 'DS':
				if (words.length < 4 || !numbers(3)) {
					fail(`${type} takes three numbers and hexadecimal data`);
					continue;
				}
				content = `${words[0]} ${words[1]} ${words[2]} ${cleanHex(words.slice(3).join(''))}`;
				break;
			case 'SSHFP':
				if (words.length < 3 || !numbers(2)) {
					fail('SSHFP takes two numbers and a hexadecimal fingerprint');
					continue;
				}
				content = `${words[0]} ${words[1]} ${cleanHex(words.slice(2).join(''))}`;
				break;
			case 'HTTPS':
			case 'SVCB':
				if (words.length < 2 || !numbers(1)) {
					fail(`${type} takes a priority, a target and optional parameters`);
					continue;
				}
				content = [
					words[0],
					target(1),
					...tokens.slice(2).map((t) => (t.quoted ? `"${t.text}"` : t.text))
				].join(' ');
				break;
			default:
				// SOA and types this build does not write: kept, so the review can say why each is left out.
				content = tokens.map((t) => (t.quoted ? `"${t.text}"` : t.text)).join(' ');
		}

		const candidate: ImportCandidate = { line: line.no, host, type, content };
		const effective = ttl ?? defaultTtl ?? lastTtl;
		if (effective !== undefined) candidate.ttl = effective;
		if (prio !== undefined) candidate.prio = prio;
		const note = /^note:\s*(.+)$/i.exec(line.comment ?? '');
		if (note) candidate.notes = note[1] as string;
		candidates.push(candidate);
	}
	unreadable.sort((a, b) => a.line - b.line);
	return { source: 'zone', candidates, unreadable };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Records from JSON: a list, or an object with a `records` list (this UI's own JSON export and Porkbun's
 * `/dns/retrieve` answer both have that). A record is `{ name | host, type, content, ttl?, prio?, notes? }`.
 */
export function parseJsonRecords(value: unknown, domain: string): ParsedSource {
	const list = Array.isArray(value)
		? value
		: isObj(value) && Array.isArray(value.records)
			? value.records
			: null;
	if (list === null) {
		return {
			source: 'json',
			candidates: [],
			unreadable: [
				{ line: 1, message: 'The JSON must be a list of records, or an object with a "records" list' }
			]
		};
	}
	const candidates: ImportCandidate[] = [];
	const unreadable: Unreadable[] = [];
	const whole = (v: unknown): number | undefined =>
		typeof v === 'number' && Number.isInteger(v) && v >= 0
			? v
			: typeof v === 'string' && /^\d{1,10}$/.test(v.trim())
				? Number(v.trim())
				: undefined;
	list.forEach((raw: unknown, i: number) => {
		const line = i + 1;
		if (!isObj(raw)) {
			unreadable.push({ line, message: 'This entry is not a record object' });
			return;
		}
		const name = raw.host ?? raw.name ?? '';
		if (typeof name !== 'string' || typeof raw.type !== 'string' || typeof raw.content !== 'string') {
			unreadable.push({ line, message: 'A record needs "name", "type" and "content" as text' });
			return;
		}
		const candidate: ImportCandidate = {
			line,
			host: normaliseHost(name, domain),
			type: raw.type.trim().toUpperCase(),
			content: raw.content
		};
		const ttl = whole(raw.ttl);
		const prio = whole(raw.prio);
		if (ttl !== undefined && ttl > 0) candidate.ttl = ttl;
		if (prio !== undefined) candidate.prio = prio;
		if (typeof raw.notes === 'string' && raw.notes.trim() !== '') candidate.notes = raw.notes.trim();
		candidates.push(candidate);
	});
	return { source: 'json', candidates, unreadable };
}

/** Read pasted text as JSON when it looks like JSON, otherwise as a zone file. */
export function parseImportText(text: string, domain: string): ParsedSource {
	const trimmed = text.trim();
	if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			return {
				source: 'json',
				candidates: [],
				unreadable: [{ line: 1, message: 'This starts like JSON but is not valid JSON' }]
			};
		}
		return parseJsonRecords(value, domain);
	}
	return parseZoneFile(text, domain);
}
