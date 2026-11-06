/**
 * The visual editor's view of a Caddyfile: the text is the document, W1's concrete syntax tree is a
 * view of it, and every edit is "mutate the tree, print it, parse the result again". Re-parsing after
 * each edit keeps every node's `span` fresh (for diagnostics and for the text editor) and means the tree
 * the inspector shows is always exactly what the text says.
 *
 * Nodes are addressed by path, not by object identity, because the tree is rebuilt after each edit:
 * `{ block: 3, nodes: [1, 0] }` is the first child of the second node of the fourth block.
 * Client-safe and DOM-free; the Svelte components wrap this in reactive state.
 */
import {
	parse,
	print,
	type Block,
	type Caddyfile,
	type Directive,
	type MatcherDef,
	type Node,
	type ParseOptions,
	type Raw
} from '@caddy-ui/caddyfile';
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { analyze, type EditorDiagnostic } from '$lib/editor/analyze';

export type NodePath = { block: number; nodes: number[] };

export function pathKey(p: NodePath): string {
	return p.nodes.length ? `${p.block}:${p.nodes.join('.')}` : String(p.block);
}

export function parsePathKey(key: string): NodePath | null {
	const m = /^(\d+)(?::((?:\d+)(?:\.\d+)*))?$/.exec(key);
	if (!m) return null;
	return { block: Number(m[1]), nodes: m[2] ? m[2].split('.').map(Number) : [] };
}

export function samePath(a: NodePath | null, b: NodePath | null): boolean {
	return a !== null && b !== null && pathKey(a) === pathKey(b);
}

export function parentPath(p: NodePath): NodePath {
	return { block: p.block, nodes: p.nodes.slice(0, -1) };
}

export function childPath(p: NodePath, index: number): NodePath {
	return { block: p.block, nodes: [...p.nodes, index] };
}

/** True when `inner` is `outer` or sits below it. */
export function isWithin(inner: NodePath, outer: NodePath): boolean {
	if (inner.block !== outer.block || inner.nodes.length < outer.nodes.length) return false;
	return outer.nodes.every((n, i) => inner.nodes[i] === n);
}

/** Raw nodes and raw blocks share `kind: 'raw'`; this tells them apart. */
export function isRawBlock(x: Block | Node): x is Extract<Block, { kind: 'raw' }> {
	return x.kind === 'raw' && 'node' in x;
}

export function isBlock(x: Block | Node): x is Block {
	return (
		x.kind === 'global' ||
		x.kind === 'snippet' ||
		x.kind === 'named_route' ||
		x.kind === 'site' ||
		x.kind === 'import' ||
		isRawBlock(x)
	);
}

/** The node that carries a block's own line (the `import` or raw line) or the node itself. */
export function lineNodeOf(x: Block | Node): Node | undefined {
	if (!isBlock(x)) return x;
	if (x.kind === 'import' || x.kind === 'raw') return x.node;
	return undefined;
}

/**
 * The list that holds a target's children, if it can have any: a block's body, a directive's body, a
 * matcher definition's body (block form) or the body of its inline module (`@m file { … }`).
 */
export function childrenOf(x: Block | Node): Node[] | undefined {
	switch (x.kind) {
		case 'global':
		case 'snippet':
		case 'named_route':
		case 'site':
			return x.body;
		case 'import':
			return x.node.body;
		case 'raw':
			return isRawBlock(x) ? x.node.body : x.body;
		case 'directive':
			return x.body;
		case 'matcher':
			return x.body ?? x.inline?.body;
	}
}

/** Like {@link childrenOf} but creates an empty body on a node that has none. */
export function ensureChildren(x: Block | Node): Node[] {
	const existing = childrenOf(x);
	if (existing) return existing;
	const target: Directive | MatcherDef | Raw = isBlock(x) ? (lineNodeOf(x) as Directive | Raw) : x;
	if (target.kind === 'matcher') {
		if (target.inline) return (target.inline.body = []);
		return (target.body = []);
	}
	return (target.body = []);
}

/** Drop an empty body (and its brace layout) so `reverse_proxy x {}` prints as `reverse_proxy x`. */
export function pruneEmptyBody(x: Block | Node, keepContainers = true): void {
	if (isBlock(x)) return;
	const node: Node = x.kind === 'matcher' && x.inline ? x.inline : x;
	if (!node.body || node.body.length > 0) return;
	if (node.layout?.innerTrivia?.some((t) => t.kind === 'comment')) return;
	if (keepContainers && node.kind === 'directive' && CONTAINERS.has(node.name.text)) return;
	delete node.body;
	if (node.layout) {
		delete node.layout.braceLeading;
		delete node.layout.braceStyle;
		delete node.layout.braceGap;
		delete node.layout.innerTrivia;
		delete node.layout.closeIndent;
		delete node.layout.closeTrailing;
		delete node.layout.closeNewline;
		delete node.layout.unclosed;
	}
}

/** Directives whose body is a list of HTTP directives, in which a `/path` token is a matcher. */
export const CONTAINERS: ReadonlySet<string> = new Set([
	'handle',
	'route',
	'handle_errors',
	'handle_path',
	'handle_response'
]);

export type Resolved = {
	block: Block;
	/** The node the path names, or undefined when the path names the block itself. */
	node?: Node;
	/** The list `node` sits in. */
	parent?: Node[];
	/** The block or node that owns `parent`. */
	owner: Block | Node;
	index?: number;
	/** The target: `node` when present, otherwise the block. */
	target: Block | Node;
};

export function resolvePath(file: Caddyfile, path: NodePath): Resolved | null {
	const block = file.blocks[path.block];
	if (!block) return null;
	if (path.nodes.length === 0) return { block, owner: block, target: block };
	let owner: Block | Node = block;
	let node: Node | undefined;
	let parent: Node[] | undefined;
	let index = -1;
	for (const i of path.nodes) {
		parent = childrenOf(owner);
		node = parent?.[i];
		if (!node || !parent) return null;
		index = i;
		owner = node;
	}
	// `owner` now is the node itself; the owner of `parent` is the previous step.
	const ownerOfParent = path.nodes.length === 1 ? block : resolvePath(file, parentPath(path))!.target;
	return { block, node, parent, owner: ownerOfParent, index, target: node! };
}

/** Walk every path of the file, parents before children. */
export function walkPaths(
	file: Caddyfile,
	visit: (path: NodePath, target: Block | Node, depth: number) => boolean | void
): void {
	const visitChildren = (owner: Block | Node, path: NodePath, depth: number) => {
		const kids = childrenOf(owner);
		if (!kids) return;
		kids.forEach((kid, i) => {
			const p = childPath(path, i);
			if (visit(p, kid, depth) !== false) visitChildren(kid, p, depth + 1);
		});
	};
	file.blocks.forEach((block, b) => {
		const p = { block: b, nodes: [] };
		if (visit(p, block, 0) !== false) visitChildren(block, p, 1);
	});
}

/** The innermost path whose span contains `offset`, for "jump to the problem" and `?line=` links. */
export function pathAt(file: Caddyfile, offset: number): NodePath | null {
	let best: NodePath | null = null;
	walkPaths(file, (path, target) => {
		const span = target.span;
		if (!span || offset < span.start || offset >= span.end) return false;
		best = path;
		return true;
	});
	return best;
}

/** The top-level block that `path` sits in. */
export function blockOf(file: Caddyfile, path: NodePath): Block | undefined {
	return file.blocks[path.block];
}

/** True when a `/path` or `*` second token would be a matcher in this body (site-like scopes). */
export function holdsDirectives(file: Caddyfile, path: NodePath): boolean {
	const r = resolvePath(file, path);
	if (!r) return false;
	if (!r.node) return r.block.kind === 'site' || r.block.kind === 'snippet' || r.block.kind === 'named_route';
	if (r.block.kind === 'global') return false;
	// Inside a directive: only containers hold directives; a matcher body holds matcher modules.
	return r.node.kind === 'directive' && CONTAINERS.has(r.node.name.text);
}

export type DocumentState = {
	text: string;
	file: Caddyfile;
	diagnostics: EditorDiagnostic[];
};

/** Parse `text` with the editor's analysis (parser + schema), the same one the text editor uses. */
export function loadDocument(text: string, schema: SchemaBundle | null, opts?: ParseOptions): DocumentState {
	const a = analyze(text, schema);
	const file = opts ? parse(text, opts).file : a.file;
	return { text, file, diagnostics: a.diagnostics };
}

/**
 * Apply an edit: mutate the tree, print it, and parse the printed text again so spans are fresh.
 * Returns the new state; the old one is left untouched only in the sense that callers must not keep
 * using its node objects (they were mutated).
 */
export function editDocument(
	state: DocumentState,
	schema: SchemaBundle | null,
	mutate: (file: Caddyfile) => void
): DocumentState {
	mutate(state.file);
	const text = print(state.file);
	return loadDocument(text, schema);
}

/** Diagnostics grouped by the innermost node path they fall in; parents see their children's worst. */
export function diagnosticsByPath(
	file: Caddyfile,
	diagnostics: readonly EditorDiagnostic[]
): Map<string, { own: EditorDiagnostic[]; worst: EditorDiagnostic['severity'] | null }> {
	const out = new Map<string, { own: EditorDiagnostic[]; worst: EditorDiagnostic['severity'] | null }>();
	const rank = { error: 3, warning: 2, info: 1 } as const;
	for (const d of diagnostics) {
		const path = pathAt(file, d.from);
		if (!path) continue;
		const key = pathKey(path);
		const entry = out.get(key) ?? { own: [], worst: null };
		entry.own.push(d);
		out.set(key, entry);
		// bubble the severity up to every ancestor, so a collapsed parent still shows a mark
		let p: NodePath = path;
		for (;;) {
			const k = pathKey(p);
			const e = out.get(k) ?? { own: [], worst: null };
			if (!e.worst || rank[d.severity] > rank[e.worst]) e.worst = d.severity;
			out.set(k, e);
			if (p.nodes.length === 0) break;
			p = parentPath(p);
		}
	}
	return out;
}
