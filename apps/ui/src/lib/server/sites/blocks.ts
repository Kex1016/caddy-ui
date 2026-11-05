import { siteId } from '../collector/sites';

/**
 * Block-level edits of a Caddyfile for the Sites page: add, duplicate, delete, disable, enable, reorder.
 *
 * Every function takes the file text and returns new text; nothing here touches the disk or Caddy. The edits
 * are splices on the original text, so every byte outside the block being changed is left exactly as it was.
 *
 * This is a deliberately small scanner, like `collector/sites.ts`. `packages/caddyfile` (W1) owns parsing;
 * once it lands, `scanBlocks` can be reimplemented on its CST with the same output (see DECISIONS.md).
 * It understands comments, quotes, backticks, heredocs and braces, which is all that finding the extent of a
 * top-level block takes.
 */

export type BlockKind = 'site' | 'global' | 'snippet' | 'route' | 'flat';

export type Block = {
	kind: BlockKind;
	/** Site blocks only: the hash of the address list (the site identity of PLAN.md §3.2). */
	id: string | null;
	/** Site blocks: the addresses. Snippets and named routes: the name in `addresses[0]`. */
	addresses: string[];
	/** Commented out by this UI. A disabled block is invisible to Caddy and to the collector. */
	disabled: boolean;
	/** First byte, including comment lines directly above the block (so they travel with it). */
	start: number;
	/** First byte of the block's own first line. */
	coreStart: number;
	/** Where the address list starts and the opening `{` starts, as offsets (enabled blocks only). */
	headStart: number;
	headEnd: number;
	/** One past the closing `}` (or the last character of a disabled block). Excludes the newline. */
	end: number;
	/** 1-based line of the block's own first line. */
	line: number;
};

export type Scan = {
	blocks: Block[];
	eol: '\n' | '\r\n';
	/** Set when the file has a shape these edits do not handle, with the reason. */
	unsupported: string | null;
};

export class BlockError extends Error {
	constructor(
		readonly code: 'unsupported' | 'not_found' | 'invalid' | 'duplicate' | 'bug',
		message: string
	) {
		super(message);
		this.name = 'BlockError';
	}
}

export const DISABLED_MARKER = '# caddy-ui:disabled';
const MARKER_RE = /^# caddy-ui:disabled lines=(\d+)$/;

type Word = { text: string; start: number; end: number; quoted: boolean };

/** Splits text into words the way Caddy's lexer does, reporting where each starts and which are on a new line. */
function* words(src: string): Generator<Word | { newline: number }> {
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i] as string;
		if (c === '\n') {
			yield { newline: i };
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
		const start = i;
		if (c === '"' || c === '`') {
			i++;
			while (i < n && src[i] !== c) {
				if (c === '"' && src[i] === '\\' && i + 1 < n) i++;
				if (src[i] === '\n') yield { newline: i };
				i++;
			}
			i++;
			yield { text: src.slice(start + 1, i - 1), start, end: Math.min(i, n), quoted: true };
			continue;
		}
		const heredoc = /^<<([A-Za-z0-9_-]+)[ \t]*\r?\n/.exec(src.slice(i, i + 64));
		if (heredoc) {
			const marker = heredoc[1] as string;
			i += heredoc[0].length;
			yield { newline: i - 1 };
			const rest = src.slice(i);
			const m = new RegExp(`^[ \\t]*${marker}(?=\\s|$)`, 'm').exec(rest);
			const body = m ? rest.slice(0, m.index) : rest;
			for (let k = 0; k < body.length; k++) if (body[k] === '\n') yield { newline: i + k };
			i += m ? m.index + m[0].length : rest.length;
			yield { text: body, start, end: i, quoted: true };
			continue;
		}
		while (i < n && !/\s/.test(src[i] as string)) i++;
		yield { text: src.slice(start, i), start, end: i, quoted: false };
	}
}

const lineStart = (src: string, offset: number) => src.lastIndexOf('\n', offset - 1) + 1;
const lineNumber = (src: string, offset: number) => {
	let line = 1;
	for (let i = src.indexOf('\n'); i !== -1 && i < offset; i = src.indexOf('\n', i + 1)) line++;
	return line;
};

/** End of the line holding `offset`, not counting a trailing `\r`. */
function lineEnd(src: string, offset: number): number {
	let e = src.indexOf('\n', offset);
	if (e === -1) e = src.length;
	return e > 0 && src[e - 1] === '\r' ? e - 1 : e;
}

function addressesOf(headWords: Word[]): string[] {
	return headWords
		.flatMap((w) => w.text.split(','))
		.map((a) => a.trim())
		.filter(Boolean);
}

type Raw = { head: Word[]; open: Word | null; close: Word | null; startOffset: number };

/** Top-level items of `src`: a head, its opening brace and its closing brace. */
function topLevel(src: string): Raw[] {
	const out: Raw[] = [];
	let depth = 0;
	let cur: Raw | null = null;
	for (const w of words(src)) {
		if ('newline' in w) {
			// A line without a brace ends a flat item, unless the address list continues after a comma.
			if (cur && depth === 0 && !cur.open) {
				const last = cur.head[cur.head.length - 1];
				if (last && !(last.text.endsWith(',') && !last.quoted)) {
					out.push(cur);
					cur = null;
				}
			}
			continue;
		}
		const open = !w.quoted && w.text === '{';
		const close = !w.quoted && w.text === '}';
		if (depth === 0) {
			if (close) continue; // stray brace: leave it to Caddy to report
			cur ??= { head: [], open: null, close: null, startOffset: w.start };
			if (open) {
				cur.open = w;
				depth = 1;
			} else cur.head.push(w);
		} else if (open) depth++;
		else if (close) {
			depth--;
			if (depth === 0 && cur) {
				cur.close = w;
				out.push(cur);
				cur = null;
			}
		}
	}
	if (cur && !cur.open) out.push(cur);
	if (depth > 0)
		throw new BlockError('unsupported', 'The Caddyfile has an opening brace that is never closed.');
	return out;
}

function kindOf(head: Word[], braced: boolean): BlockKind {
	if (!braced) return 'flat';
	if (head.length === 0) return 'global';
	const first = head[0] as Word;
	if (head.length === 1 && !first.quoted && /^\(.+\)$/.test(first.text)) return 'snippet';
	if (head.length === 1 && !first.quoted && /^&\(.+\)$/.test(first.text)) return 'route';
	return 'site';
}

function stripComment(line: string): string {
	return line.replace(/^# ?/, '');
}

function commentOut(lines: string[]): string[] {
	return lines.map((l) => (l.replace(/\r$/, '') === '' ? `#${l}` : `# ${l}`));
}

/** Finds every top-level block, in file order. Never throws; a file it cannot handle sets `unsupported`. */
export function scanBlocks(src: string): Scan {
	const eol = src.includes('\r\n') ? '\r\n' : '\n';
	let raws: Raw[];
	try {
		raws = topLevel(src);
	} catch (err) {
		return { blocks: [], eol, unsupported: err instanceof BlockError ? err.message : String(err) };
	}

	const blocks: Block[] = [];
	let unsupported: string | null = null;
	for (const r of raws) {
		const kind = kindOf(r.head, r.open !== null);
		if (kind === 'flat') {
			const first = r.head[0]?.text;
			// `import` and similar one-line top-level items are fine; a site written without braces is not.
			if (first !== 'import')
				unsupported = 'This Caddyfile has a site written without braces; edit it as text.';
			continue;
		}
		const coreStart = lineStart(src, r.startOffset);
		const close = r.close as Word;
		const addresses = kind === 'site' ? addressesOf(r.head) : [r.head[0]?.text ?? ''];
		blocks.push({
			kind,
			id: kind === 'site' ? siteId(addresses) : null,
			addresses,
			disabled: false,
			start: coreStart,
			coreStart,
			headStart: r.head[0]?.start ?? (r.open as Word).start,
			headEnd: (r.open as Word).start,
			end: lineEnd(src, close.end),
			line: lineNumber(src, coreStart)
		});
	}

	// Blocks this UI disabled: a marker line, then that many commented-out lines.
	const lines = src.split('\n');
	let offset = 0;
	for (let li = 0; li < lines.length; li++) {
		const raw = lines[li] as string;
		const m = MARKER_RE.exec(raw.replace(/\r$/, ''));
		const count = m ? Number(m[1]) : 0;
		if (m && count > 0 && li + count < lines.length) {
			const body = lines.slice(li + 1, li + 1 + count);
			if (body.length === count && body.every((l) => l.startsWith('#'))) {
				const inner = body.map(stripComment).join('\n');
				const found = scanBlocks(inner).blocks.find((b) => b.kind === 'site');
				if (found) {
					const endOffset = lines.slice(0, li + 1 + count).join('\n').length;
					blocks.push({
						...found,
						disabled: true,
						start: offset,
						coreStart: offset,
						headStart: offset,
						headEnd: offset,
						end: endOffset > 0 && src[endOffset - 1] === '\r' ? endOffset - 1 : endOffset,
						line: li + 2
					});
				}
			}
		}
		offset += raw.length + 1;
	}

	blocks.sort((a, b) => a.coreStart - b.coreStart);

	// Comment lines directly above a block (no blank line between) belong to it.
	let prevEnd = 0;
	for (const b of blocks) {
		let start = b.coreStart;
		while (start > prevEnd) {
			const ps = lineStart(src, start - 1);
			if (ps < prevEnd) break;
			const text = src.slice(ps, start).trim();
			if (!text.startsWith('#')) break;
			start = ps;
		}
		b.start = start;
		prevEnd = b.end;
	}
	return { blocks, eol, unsupported };
}

function scanForEdit(text: string): Scan {
	const scan = scanBlocks(text);
	if (scan.unsupported) throw new BlockError('unsupported', scan.unsupported);
	return scan;
}

function findSite(scan: Scan, id: string): Block {
	const b = scan.blocks.find((x) => x.kind === 'site' && x.id === id);
	if (!b) throw new BlockError('not_found', 'That site is no longer in the Caddyfile. Reload the page.');
	return b;
}

/**
 * Edits must leave every other site as it was. This is the check that catches a bug in the scanner or in an
 * edit: the ids of the sites after the edit must be exactly the ids expected.
 */
function expectSites(text: string, expected: string[], what: string): string {
	const got = scanBlocks(text)
		.blocks.filter((b) => b.kind === 'site')
		.map((b) => b.id as string);
	const same = got.length === expected.length && [...got].sort().join() === [...expected].sort().join();
	if (!same)
		throw new BlockError('bug', `Refusing to ${what}: the edit would change other sites. This is a bug.`);
	return text;
}

const ids = (scan: Scan) => scan.blocks.filter((b) => b.kind === 'site').map((b) => b.id as string);

// ── addresses and starters ───────────────────────────────────────────────────────────────────

/** Splits what a person typed into addresses and rejects anything that cannot be one. */
export function parseAddresses(input: string): string[] {
	const parts = input
		.split(/[\s,]+/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0)
		throw new BlockError('invalid', 'Enter at least one address, such as app.example.com.');
	for (const p of parts) {
		const stripped = p.replace(/\{\$?[A-Za-z0-9_.:-]+\}/g, '');
		if (/["`#{}]/.test(stripped)) throw new BlockError('invalid', `“${p}” is not a valid site address.`);
	}
	return parts;
}

export type Starter = 'blank' | 'reverse_proxy' | 'file_server' | 'redirect';

export const STARTERS: { id: Starter; label: string; field?: { label: string; placeholder: string } }[] = [
	{ id: 'blank', label: 'Blank block' },
	{
		id: 'reverse_proxy',
		label: 'Reverse proxy',
		field: { label: 'Upstream', placeholder: '10.0.0.10:8080' }
	},
	{ id: 'file_server', label: 'Static files', field: { label: 'Folder', placeholder: '/srv/www' } },
	{
		id: 'redirect',
		label: 'Redirect',
		field: { label: 'Send visitors to', placeholder: 'https://example.com' }
	}
];

function oneToken(value: string, what: string): string {
	const v = value.trim();
	if (v === '') throw new BlockError('invalid', `Enter ${what}.`);
	if (/[\s{}"`#]/.test(v))
		throw new BlockError(
			'invalid',
			`${what[0]?.toUpperCase()}${what.slice(1)} cannot contain spaces, quotes or braces.`
		);
	return v;
}

/** A new site block from a starter. Indented with tabs, as `caddy fmt` writes it. */
export function starterBlock(addresses: string[], starter: Starter, value = '', eol = '\n'): string {
	let body: string[];
	switch (starter) {
		case 'blank':
			body = [];
			break;
		case 'reverse_proxy':
			body = [`reverse_proxy ${oneToken(value, 'an upstream address')}`];
			break;
		case 'file_server':
			body = [`root * ${oneToken(value, 'a folder')}`, 'file_server'];
			break;
		case 'redirect':
			body = [`redir ${oneToken(value, 'a URL')}{uri} permanent`];
			break;
		default:
			throw new BlockError('invalid', 'Pick a starting point for the new site.');
	}
	return [`${addresses.join(', ')} {`, ...body.map((l) => `\t${l}`), '}'].join(eol);
}

// ── edits ────────────────────────────────────────────────────────────────────────────────────

function assertNewSite(scan: Scan, addresses: string[]) {
	const id = siteId(addresses);
	const clash = scan.blocks.find((b) => b.kind === 'site' && b.id === id);
	if (clash) {
		throw new BlockError(
			'duplicate',
			clash.disabled
				? `${addresses.join(', ')} is already in the Caddyfile as a disabled site. Enable that one instead.`
				: `${addresses.join(', ')} is already a site in the Caddyfile.`
		);
	}
}

/** Appends a new site after the last existing one. */
export function addSite(text: string, block: string, addresses: string[]): string {
	const scan = scanForEdit(text);
	assertNewSite(scan, addresses);
	const before = ids(scan);
	const sites = scan.blocks.filter((b) => b.kind === 'site');
	let out: string;
	if (sites.length > 0) {
		const at = (sites[sites.length - 1] as Block).end;
		out = text.slice(0, at) + scan.eol + scan.eol + block + text.slice(at);
	} else {
		const trimmed = text.replace(/\s+$/, '');
		out = (trimmed ? trimmed + scan.eol + scan.eol : '') + block + scan.eol;
	}
	return expectSites(out, [...before, siteId(addresses)], 'add the site');
}

/** Copies a site block under new addresses, directly after the original. */
export function duplicateSite(text: string, id: string, addresses: string[]): string {
	const scan = scanForEdit(text);
	const src = findSite(scan, id);
	if (src.disabled) throw new BlockError('invalid', 'Enable the site before duplicating it.');
	assertNewSite(scan, addresses);
	const copy =
		text.slice(src.coreStart, src.headStart) + addresses.join(', ') + ' ' + text.slice(src.headEnd, src.end);
	const out = text.slice(0, src.end) + scan.eol + scan.eol + copy + text.slice(src.end);
	return expectSites(out, [...ids(scan), siteId(addresses)], 'duplicate the site');
}

/** Removes a site block, its leading comment lines, and one of the blank lines around it. */
export function deleteSite(text: string, id: string): string {
	const scan = scanForEdit(text);
	const b = findSite(scan, id);
	let before = text.slice(0, b.start);
	let after = text.slice(b.end);
	after = after.replace(/^\r?\n/, '');
	// The block sat between blank lines (or at an edge): keep one blank line, not two.
	if (/(\r?\n){2}$/.test(before) || before === '') after = after.replace(/^([ \t]*\r?\n)+/, '');
	if (after === '') before = before.replace(/(\r?\n)+$/, scan.eol);
	const out = before + after;
	return expectSites(
		out,
		ids(scan).filter((x) => x !== id),
		'delete the site'
	);
}

/** Comments a site out (so Caddy ignores it) or brings it back. Both directions restore the original bytes. */
export function setSiteDisabled(text: string, id: string, disabled: boolean): string {
	const scan = scanForEdit(text);
	const b = findSite(scan, id);
	if (b.disabled === disabled) return text;
	let out: string;
	if (disabled) {
		const lines = text.slice(b.coreStart, b.end).split(scan.eol);
		out =
			text.slice(0, b.coreStart) +
			[`${DISABLED_MARKER} lines=${lines.length}`, ...commentOut(lines)].join(scan.eol) +
			text.slice(b.end);
	} else {
		const marker = lineEnd(text, b.coreStart);
		const lines = text.slice(marker + (text[marker] === '\r' ? 2 : 1), b.end).split(scan.eol);
		out = text.slice(0, b.coreStart) + lines.map(stripComment).join(scan.eol) + text.slice(b.end);
	}
	return expectSites(out, ids(scan), disabled ? 'disable the site' : 'enable the site');
}

/** Moves a site one place up or down among the sites. Snippets, globals and everything between stay put. */
export function moveSite(text: string, id: string, direction: 'up' | 'down'): string {
	const scan = scanForEdit(text);
	const sites = scan.blocks.filter((b) => b.kind === 'site');
	const at = sites.findIndex((b) => b.id === id);
	if (at === -1)
		throw new BlockError('not_found', 'That site is no longer in the Caddyfile. Reload the page.');
	const to = direction === 'up' ? at - 1 : at + 1;
	if (to < 0 || to >= sites.length) return text;
	const [a, b] =
		at < to ? [sites[at] as Block, sites[to] as Block] : [sites[to] as Block, sites[at] as Block];
	// Swap the two blocks' text; everything between them (and around them) stays where it is.
	const out =
		text.slice(0, a.start) +
		text.slice(b.start, b.end) +
		text.slice(a.end, b.start) +
		text.slice(a.start, a.end) +
		text.slice(b.end);
	return expectSites(out, ids(scan), 'move the site');
}
