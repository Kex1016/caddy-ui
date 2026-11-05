import type { Block, Caddyfile, Directive, Node, SiteBlock, Span, Token } from './types.js';

export interface Position {
	/** 1-based line number, as Caddy reports it in `/adapt` errors. */
	line: number;
	/** 1-based column in UTF-16 code units. */
	column: number;
}

/** Convert a character offset into a 1-based line and column. */
export function positionAt(text: string, offset: number): Position {
	const o = Math.max(0, Math.min(offset, text.length));
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < o; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, column: o - lineStart + 1 };
}

/** Convert a 1-based line (and optional column) into a character offset. */
export function offsetAt(text: string, line: number, column = 1): number {
	let cur = 1;
	let i = 0;
	while (cur < line && i < text.length) {
		if (text.charCodeAt(i) === 10) cur++;
		i++;
	}
	return Math.min(text.length, i + Math.max(0, column - 1));
}

/** Span of a whole 1-based line, without its newline. Handy for `/adapt` error line numbers. */
export function lineSpan(text: string, line: number): Span {
	const start = offsetAt(text, line, 1);
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) end++;
	return { start, end };
}

export interface NodePath {
	block: Block;
	/** Ancestors from the block body down to the node's parent. */
	ancestors: Node[];
	node: Node;
}

/** Visit every node of the file depth-first. Return `false` from the visitor to skip a node's body. */
export function walk(file: Caddyfile, visit: (node: Node, path: NodePath) => boolean | void): void {
	const visitNodes = (nodes: readonly Node[], block: Block, ancestors: Node[]): void => {
		for (const node of nodes) {
			const r = visit(node, { block, ancestors, node });
			if (r !== false && node.body) visitNodes(node.body, block, [...ancestors, node]);
			if (r !== false && node.kind === 'matcher' && node.inline) {
				const r2 = visit(node.inline, { block, ancestors: [...ancestors, node], node: node.inline });
				if (r2 !== false && node.inline.body)
					visitNodes(node.inline.body, block, [...ancestors, node, node.inline]);
			}
		}
	};
	for (const block of file.blocks) {
		if (block.kind === 'import' || block.kind === 'raw') {
			visit(block.node, { block, ancestors: [], node: block.node });
			if (block.node.body) visitNodes(block.node.body, block, [block.node]);
		} else {
			visitNodes(block.body, block, []);
		}
	}
}

/** All directives named `name` anywhere in the file (including nested ones). */
export function findDirectives(file: Caddyfile, name: string): Directive[] {
	const out: Directive[] = [];
	walk(file, (n) => {
		if (n.kind === 'directive' && n.name.text === name) out.push(n);
	});
	return out;
}

export function sites(file: Caddyfile): SiteBlock[] {
	return file.blocks.filter((b): b is SiteBlock => b.kind === 'site');
}

function contains(span: Span | undefined, offset: number): boolean {
	return span !== undefined && offset >= span.start && offset < span.end;
}

/** The block whose source span contains the offset, if any. */
export function blockAt(file: Caddyfile, offset: number): Block | undefined {
	return file.blocks.find((b) => contains(b.span, offset));
}

/** The innermost node whose source span contains the offset, with its path. */
export function nodeAt(file: Caddyfile, offset: number): NodePath | undefined {
	let best: NodePath | undefined;
	walk(file, (node, path) => {
		if (!contains(node.span, offset)) return false;
		best = path;
		return true;
	});
	return best;
}

/** The token whose span contains the offset, searched through the whole file. */
export function tokenAt(file: Caddyfile, offset: number): Token | undefined {
	for (const block of file.blocks) {
		if (block.kind === 'site') {
			const a = block.addresses.find((t) => contains(t.span, offset));
			if (a) return a;
		}
		if (
			(block.kind === 'snippet' || block.kind === 'named_route') &&
			contains(block.nameToken?.span, offset)
		) {
			return block.nameToken;
		}
	}
	let found: Token | undefined;
	walk(file, (node) => {
		if (!contains(node.span, offset)) return false;
		const tokens: Token[] =
			node.kind === 'raw'
				? node.tokens
				: node.kind === 'directive'
					? [node.name, ...(node.matcher ? [node.matcher] : []), ...node.args]
					: [node.name, ...(node.inline ? [node.inline.name, ...node.inline.args] : [])];
		const t = tokens.find((tok) => contains(tok.span, offset));
		if (t) found = t;
		return true;
	});
	return found;
}

/**
 * Stable identity of a site block: its address list, normalised (trimmed,
 * lower-cased, sorted, de-duplicated). Reordering or editing the body keeps
 * the key; changing an address changes it. Mirrors PLAN.md §3.2 "Site identity".
 */
export function siteKey(site: SiteBlock): string {
	const addrs = site.addresses
		.map((a) => a.text.trim().toLowerCase())
		.filter((a) => a.length > 0)
		.sort();
	return Array.from(new Set(addrs)).join(' ');
}

/** 16-hex-character hash of {@link siteKey}, usable as a URL-safe id. */
export function siteId(site: SiteBlock): string {
	return hash64(siteKey(site));
}

/** FNV-1a (32-bit) and a second independent 32-bit hash, concatenated. */
function hash64(s: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x1b873593;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 ^= c;
		h1 = Math.imul(h1, 0x01000193) >>> 0;
		h2 = (Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15)) >>> 0;
	}
	return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** A short human summary of a node, for tree outlines: `reverse_proxy → 10.0.0.1:80`, `@api path /api/*`. */
export function summarize(node: Node): string {
	switch (node.kind) {
		case 'directive': {
			const args = node.args.map((a) => a.text).join(' ');
			const m = node.matcher ? ' ' + node.matcher.text : '';
			return node.name.text + m + (args ? ' ' + args : '');
		}
		case 'matcher':
			if (node.inline)
				return node.name.text + ' ' + [node.inline.name, ...node.inline.args].map((a) => a.text).join(' ');
			return node.name.text + ' { … }';
		case 'raw':
			return node.tokens.map((t) => t.text).join(' ');
	}
}
