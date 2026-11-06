import { parse } from './parser.js';
import { print } from './printer.js';
import type { Block, Caddyfile, Layout, Node, Raw, Token, Trivia } from './types.js';

export interface FormatOptions {
	/** Indentation unit. `caddy fmt` uses a tab. */
	indentUnit?: string;
	/** Line terminator. Defaults to `\n`. */
	newline?: string;
}

/**
 * Produce `caddy fmt`-style output: tab indentation by nesting depth, one
 * space between tokens, no trailing whitespace, at most one consecutive blank
 * line, no blank lines at the start of the file, exactly one newline at the
 * end. Token spelling (quotes, heredocs) and comments are kept as written.
 *
 * Accepts either source text or a parsed tree; the tree is not modified.
 */
export function format(input: string | Caddyfile, opts: FormatOptions = {}): string {
	const file = typeof input === 'string' ? parse(input).file : input;
	const normalized = normalizeFile(file);
	const out = print(normalized, { indentUnit: opts.indentUnit ?? '\t', newline: opts.newline ?? '\n' });
	return out.length > 0 && !out.endsWith('\n') ? out + (opts.newline ?? '\n') : out;
}

/**
 * Return a deep copy of the tree with all layout information removed, so that
 * the printer re-synthesises whitespace. Comments are kept; blank-line runs are
 * collapsed to one; leading blank lines of the file are dropped.
 */
export function normalizeFile(file: Caddyfile): Caddyfile {
	const blocks = file.blocks.map(normalizeBlock);
	const first = blocks[0];
	const tail = dropTrailingBlanks(normalizeTrivia(file.trivia));
	if (first) first.trivia = dropLeadingBlanks(first.trivia);
	else return { blocks, trivia: dropLeadingBlanks(tail) };
	return { blocks, trivia: tail };
}

function dropTrailingBlanks(trivia: Trivia[]): Trivia[] {
	let n = trivia.length;
	while (n > 0 && trivia[n - 1]!.kind === 'blank') n--;
	return trivia.slice(0, n);
}

function dropLeadingBlanks(trivia: Trivia[]): Trivia[] {
	let i = 0;
	while (i < trivia.length && trivia[i]!.kind === 'blank') i++;
	return trivia.slice(i);
}

function normalizeTrivia(trivia: readonly Trivia[]): Trivia[] {
	const out: Trivia[] = [];
	for (const t of trivia) {
		if (t.kind === 'blank') {
			if (out[out.length - 1]?.kind === 'blank') continue;
			out.push({ kind: 'blank', text: '' });
		} else {
			out.push({ kind: 'comment', text: t.text.replace(/[ \t]+$/, '') });
		}
	}
	return out;
}

function normalizeLayout(layout: Layout | undefined): Layout | undefined {
	if (!layout) return undefined;
	const out: Layout = {};
	if (layout.trailing && layout.trailing.includes('#')) out.trailing = ' ' + layout.trailing.trim();
	if (layout.closeTrailing && layout.closeTrailing.includes('#'))
		out.closeTrailing = ' ' + layout.closeTrailing.trim();
	if (layout.braceStyle === 'empty') out.braceStyle = 'empty';
	if (layout.innerTrivia && layout.innerTrivia.length) {
		out.innerTrivia = normalizeTrivia(layout.innerTrivia);
	}
	return Object.keys(out).length ? out : undefined;
}

function normalizeToken(tok: Token, keepNewlines: boolean): Token {
	const out: Token = { text: tok.text, quote: tok.quote };
	if (tok.raw !== undefined) out.raw = tok.raw;
	if (tok.heredocMarker !== undefined) out.heredocMarker = tok.heredocMarker;
	if (keepNewlines && tok.leading !== undefined && /[\r\n]/.test(tok.leading)) {
		// multi-line address lists keep their line breaks and any comments in between
		out.leading = tok.leading.includes('#')
			? tok.leading
			: tok.leading.replace(/[ \t]+/g, '').replace(/\r?\n/g, '\n');
	}
	return out;
}

function normalizeNodes(nodes: readonly Node[] | undefined, _afterOpenBrace: boolean): Node[] | undefined {
	if (!nodes) return undefined;
	return nodes.map(normalizeNode);
}

function normalizeNode(node: Node): Node {
	const trivia = normalizeTrivia(node.trivia);
	const layout = normalizeLayout(node.layout);
	switch (node.kind) {
		case 'directive': {
			const d: Node = {
				kind: 'directive',
				name: normalizeToken(node.name, false),
				args: node.args.map((t) => normalizeToken(t, false)),
				trivia
			};
			if (node.matcher)
				d.matcher = { ...normalizeToken(node.matcher, false), matcherKind: node.matcher.matcherKind };
			const body = normalizeNodes(node.body, true);
			if (body) d.body = body;
			if (layout) d.layout = layout;
			return d;
		}
		case 'matcher': {
			const m: Node = { kind: 'matcher', name: normalizeToken(node.name, false), trivia };
			if (node.inline) {
				m.inline = {
					kind: 'directive',
					name: normalizeToken(node.inline.name, false),
					args: node.inline.args.map((t) => normalizeToken(t, false)),
					trivia: []
				};
				const inlineBody = normalizeNodes(node.inline.body, true);
				if (inlineBody) m.inline.body = inlineBody;
			}
			const body = normalizeNodes(node.body, true);
			if (body) m.body = body;
			if (layout) m.layout = layout;
			return m;
		}
		case 'raw': {
			const r: Node = { kind: 'raw', tokens: node.tokens.map((t) => normalizeToken(t, false)), trivia };
			const body = normalizeNodes(node.body, true);
			if (body) r.body = body;
			if (layout) r.layout = layout;
			return r;
		}
	}
}

function normalizeBlock(block: Block): Block {
	const trivia = normalizeTrivia(block.trivia);
	const layout = normalizeLayout(block.layout);
	switch (block.kind) {
		case 'import': {
			const node = normalizeNode(block.node);
			if (node.kind === 'directive') return { kind: 'import', node, trivia };
			return { kind: 'raw', node: node as Raw, trivia };
		}
		case 'raw': {
			const node = normalizeNode(block.node);
			return { kind: 'raw', node: node as Raw, trivia };
		}
		case 'global': {
			const b: Block = { kind: 'global', body: normalizeNodes(block.body, true) ?? [], trivia };
			if (layout) b.layout = layout;
			return b;
		}
		case 'snippet': {
			const b: Block = {
				kind: 'snippet',
				name: block.name,
				body: normalizeNodes(block.body, true) ?? [],
				trivia
			};
			if (block.nameToken) b.nameToken = normalizeToken(block.nameToken, false);
			if (layout) b.layout = layout;
			return b;
		}
		case 'named_route': {
			const b: Block = {
				kind: 'named_route',
				name: block.name,
				body: normalizeNodes(block.body, true) ?? [],
				trivia
			};
			if (block.nameToken) b.nameToken = normalizeToken(block.nameToken, false);
			if (layout) b.layout = layout;
			return b;
		}
		case 'site': {
			const b: Block = {
				kind: 'site',
				addresses: block.addresses.map((t) => normalizeToken(t, true)),
				body: normalizeNodes(block.body, block.braces !== false) ?? [],
				trivia
			};
			if (block.braces === false) b.braces = false;
			if (layout) b.layout = layout;
			return b;
		}
	}
}
