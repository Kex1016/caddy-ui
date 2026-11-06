/**
 * The outline on the left of the visual editor: the tree flattened into rows, with a name, a one-line
 * summary and the expand state for each. Pure data; `Tree.svelte` renders it.
 */
import type { Block, Caddyfile, Directive, MatcherDef, Node, Raw } from '@caddy-ui/caddyfile';
import type { EditorDiagnostic } from '$lib/editor/analyze';
import { childrenOf, childPath, diagnosticsByPath, isRawBlock, pathKey, type NodePath } from './document';

export type RowKind =
	'global' | 'snippet' | 'named_route' | 'site' | 'import' | 'directive' | 'matcher' | 'raw';

export type TreeRow = {
	key: string;
	path: NodePath;
	depth: number;
	kind: RowKind;
	/** The thing's name: a directive, `@matcher`, `(snippet)`, the site addresses, "Global options". */
	name: string;
	/** Arguments and matcher, shortened for one line. */
	summary: string;
	/** The matcher token of a directive, shown as a chip. */
	matcher?: string;
	/** The first comment line above the node, as people label sites (`# Jellyfin`). */
	note?: string;
	hasChildren: boolean;
	childCount: number;
	expanded: boolean;
	severity: EditorDiagnostic['severity'] | null;
};

const MAX_SUMMARY = 72;

function shorten(s: string): string {
	return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + '…' : s;
}

function noteOf(x: { trivia: { kind: string; text: string }[] }): string | undefined {
	// The comment directly above (no blank line between), as W8 does for the sites list.
	const last = x.trivia[x.trivia.length - 1];
	if (!last || last.kind !== 'comment') return undefined;
	const t = last.text.replace(/^#+\s?/, '').trim();
	return t && !t.startsWith('caddy-ui:') ? shorten(t) : undefined;
}

/** `reverse_proxy` with no inline upstreams shows its `to` lines; `handle` shows its matcher only. */
export function directiveSummary(d: Directive): string {
	const args = d.args.map((a) => a.text);
	if (args.length === 0 && d.body) {
		const to = d.body.filter(
			(n): n is Directive => n.kind === 'directive' && (n.name.text === 'to' || n.name.text === 'upstreams')
		);
		if (to.length) return shorten('→ ' + to.flatMap((n) => n.args.map((a) => a.text)).join(' '));
		return `${d.body.length} ${d.body.length === 1 ? 'line' : 'lines'}`;
	}
	if (
		(d.name.text === 'reverse_proxy' || d.name.text === 'forward_auth' || d.name.text === 'php_fastcgi') &&
		args.length
	)
		return shorten('→ ' + args.join(' '));
	if (d.name.text === 'redir' && args.length) return shorten('→ ' + args.join(' '));
	return shorten(args.join(' '));
}

export function matcherSummary(m: MatcherDef): string {
	if (m.inline) {
		const inline = m.inline;
		const head = [inline.name, ...inline.args].map((a) => a.text).join(' ');
		return shorten(inline.body ? `${head} { … }` : head);
	}
	const mods = (m.body ?? []).map((n) =>
		n.kind === 'directive' ? [n.name, ...n.args].map((a) => a.text).join(' ') : '…'
	);
	return shorten(mods.join(' · '));
}

export function rawSummary(r: Raw): string {
	return shorten(r.tokens.map((t) => t.text).join(' '));
}

export function blockName(b: Block): string {
	switch (b.kind) {
		case 'global':
			return 'Global options';
		case 'snippet':
			return `(${b.name})`;
		case 'named_route':
			return `&(${b.name})`;
		case 'site':
			return b.addresses.map((a) => a.text).join(', ') || '(no address)';
		case 'import':
			return 'import';
		case 'raw':
			return 'unparsed';
	}
}

export function rowKindOf(x: Block | Node): RowKind {
	if (x.kind === 'raw') return 'raw';
	return x.kind;
}

export function rowNameOf(x: Block | Node): string {
	switch (x.kind) {
		case 'directive':
			return x.name.text;
		case 'matcher':
			return x.name.text;
		case 'raw':
			return isRawBlock(x) ? 'unparsed' : x.tokens[0]?.text || 'unparsed';
		default:
			return blockName(x);
	}
}

export function rowSummaryOf(x: Block | Node): string {
	switch (x.kind) {
		case 'directive':
			return directiveSummary(x);
		case 'matcher':
			return matcherSummary(x);
		case 'raw':
			return isRawBlock(x)
				? rawSummary(x.node)
				: shorten(
						x.tokens
							.slice(1)
							.map((t) => t.text)
							.join(' ')
					);
		case 'import':
			return shorten(x.node.args.map((a) => a.text).join(' '));
		case 'site':
			return x.body.length ? `${x.body.length} ${x.body.length === 1 ? 'line' : 'lines'}` : 'empty';
		default:
			return x.body.length ? `${x.body.length} ${x.body.length === 1 ? 'line' : 'lines'}` : 'empty';
	}
}

export type FlattenOptions = {
	expanded: ReadonlySet<string>;
	diagnostics?: readonly EditorDiagnostic[];
	/** Keep only these blocks (by index); the Globals page shows the non-site blocks. */
	blockFilter?: (block: Block, index: number) => boolean;
	/** Search: rows whose name, summary or note match stay, with their ancestors. */
	query?: string;
};

/** Flatten the file into rows in file order, honouring the expand set. */
export function flattenTree(file: Caddyfile, opts: FlattenOptions): TreeRow[] {
	const diags = diagnosticsByPath(file, opts.diagnostics ?? []);
	const q = opts.query?.trim().toLowerCase() ?? '';
	const rows: TreeRow[] = [];

	const matches = (row: Omit<TreeRow, 'expanded' | 'hasChildren' | 'childCount' | 'severity'>) =>
		q === '' ||
		row.name.toLowerCase().includes(q) ||
		row.summary.toLowerCase().includes(q) ||
		(row.note?.toLowerCase().includes(q) ?? false);

	const visit = (x: Block | Node, path: NodePath, depth: number): boolean => {
		const key = pathKey(path);
		const kids = childrenOf(x);
		const base = {
			key,
			path,
			depth,
			kind: rowKindOf(x),
			name: rowNameOf(x),
			summary: rowSummaryOf(x),
			matcher: x.kind === 'directive' ? x.matcher?.text : undefined,
			note: noteOf(x)
		};
		const row: TreeRow = {
			...base,
			hasChildren: (kids?.length ?? 0) > 0,
			childCount: kids?.length ?? 0,
			expanded: q !== '' || opts.expanded.has(key),
			severity: diags.get(key)?.worst ?? null
		};
		const at = rows.length;
		rows.push(row);
		let anyChild = false;
		if (kids && row.expanded) {
			kids.forEach((kid, i) => {
				if (visit(kid, childPath(path, i), depth + 1)) anyChild = true;
			});
		}
		const keep = q === '' || matches(base) || anyChild;
		if (!keep) rows.splice(at, rows.length - at);
		return keep;
	};

	file.blocks.forEach((block, b) => {
		if (opts.blockFilter && !opts.blockFilter(block, b)) return;
		visit(block, { block: b, nodes: [] }, 0);
	});
	return rows;
}

/** Keys of every block and node that has children, for "expand all". */
export function allExpandableKeys(file: Caddyfile, blockFilter?: FlattenOptions['blockFilter']): string[] {
	const keys: string[] = [];
	const visit = (x: Block | Node, path: NodePath) => {
		const kids = childrenOf(x);
		if (!kids?.length) return;
		keys.push(pathKey(path));
		kids.forEach((kid, i) => visit(kid, childPath(path, i)));
	};
	file.blocks.forEach((block, b) => {
		if (blockFilter && !blockFilter(block, b)) return;
		visit(block, { block: b, nodes: [] });
	});
	return keys;
}
