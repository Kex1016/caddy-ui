/**
 * What the inspector shows for a path: which form applies to the node there (a directive form, a
 * global option form, a matcher module form, a schema-described subdirective, or nothing for raw
 * lines), and the context the form's fields need. DOM-free so the choice can be tested.
 */
import {
	createToken,
	nodesFromText,
	printNodes,
	relayout,
	type Block,
	type Caddyfile,
	type Directive,
	type Node,
	type SiteBlock,
	type Trivia
} from '@caddy-ui/caddyfile';
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import {
	CONTAINERS,
	childrenOf,
	holdsDirectives,
	isBlock,
	parentPath,
	resolvePath,
	type NodePath
} from './document';
import { resolveSchema } from './forms/directives/schema-fields';
import {
	formForDirective,
	formForGlobalOption,
	formForMatcher,
	formForSchemaNode,
	type FormLookup
} from './forms';
import type { FormContext } from './forms/types';
import { matcherNamesIn } from './matcher';
import { availablePlaceholders, placeholderContext } from './placeholders';

export type Role =
	| 'block'
	| 'directive'
	| 'global_option'
	| 'matcher'
	| 'response_matcher'
	| 'matcher_module'
	| 'subdirective'
	| 'raw';

/** The names of the nodes from the top-level body down to `path` (exclusive of blocks). */
export function ancestorNames(file: Caddyfile, path: NodePath): string[] {
	const names: string[] = [];
	for (let i = 1; i <= path.nodes.length; i++) {
		const r = resolvePath(file, { block: path.block, nodes: path.nodes.slice(0, i) });
		const n = r?.node;
		names.push(n?.kind === 'directive' ? n.name.text : n?.kind === 'matcher' ? n.name.text : '');
	}
	return names;
}

export function roleOf(file: Caddyfile, path: NodePath): Role | null {
	const r = resolvePath(file, path);
	if (!r) return null;
	if (!r.node) return 'block';
	const node = r.node;
	if (node.kind === 'raw') return 'raw';
	// Inside a matcher definition everything is a matcher module (`not { path /x }` nests them).
	const insideMatcher = path.nodes.length > 1 && ancestorsInclude(file, path, (n) => n.kind === 'matcher');
	if (node.kind === 'matcher')
		return r.block.kind !== 'global' && (isBlock(r.owner) || isContainer(r.owner))
			? 'matcher'
			: 'response_matcher';
	if (insideMatcher) return 'matcher_module';
	if (r.block.kind === 'global') return path.nodes.length === 1 ? 'global_option' : 'subdirective';
	if (isBlock(r.owner)) return 'directive';
	if (isContainer(r.owner)) return 'directive';
	return 'subdirective';
}

function isContainer(x: Block | Node): boolean {
	return x.kind === 'directive' && CONTAINERS.has(x.name.text);
}

function ancestorsInclude(file: Caddyfile, path: NodePath, test: (n: Node) => boolean): boolean {
	for (let i = 1; i < path.nodes.length; i++) {
		const n = resolvePath(file, { block: path.block, nodes: path.nodes.slice(0, i) })?.node;
		if (n && test(n)) return true;
	}
	return false;
}

/** The form for the node at `path`, or null for blocks, raw lines and matcher definitions. */
export function formForPath(schema: SchemaBundle | null, file: Caddyfile, path: NodePath): FormLookup | null {
	const r = resolvePath(file, path);
	const node = r?.node;
	if (!r || !node || node.kind !== 'directive') return null;
	const name = node.name.text;
	switch (roleOf(file, path)) {
		case 'directive':
			return formForDirective(schema, name);
		case 'global_option':
			return formForGlobalOption(schema, name);
		case 'matcher_module': {
			const def = matcherDefPathOf(file, path);
			return formForMatcher(schema, name, def ? roleOf(file, def) === 'response_matcher' : false);
		}
		case 'subdirective': {
			// Walk the schema from the nearest directive/global option ancestor down to this node.
			const names = ancestorNames(file, path);
			const root = r.block.kind === 'global' ? 'globalOptions' : 'directives';
			// Drop ancestors above the last container (a subdirective's schema path starts at its directive).
			let start = 0;
			for (let i = 0; i < names.length - 1; i++) if (CONTAINERS.has(names[i]!)) start = i + 1;
			const s = resolveSchema(schema, names.slice(start), root);
			if (s) return formForSchemaNode(s);
			return formForDirective(null, name);
		}
		default:
			return null;
	}
}

/** The path of the nearest enclosing matcher definition, for a matcher module. */
export function matcherDefPathOf(file: Caddyfile, path: NodePath): NodePath | null {
	for (let i = path.nodes.length - 1; i >= 1; i--) {
		const p = { block: path.block, nodes: path.nodes.slice(0, i) };
		if (resolvePath(file, p)?.node?.kind === 'matcher') return p;
	}
	return null;
}

/** The context a form's fields get: matcher names, snippet names, placeholders, where the node sits. */
export function formContextFor(schema: SchemaBundle | null, file: Caddyfile, path: NodePath): FormContext {
	const r = resolvePath(file, path);
	const block = r?.block;
	const body = block ? (childrenOf(block) ?? []) : [];
	return {
		matcherNames: matcherNamesIn(body),
		snippetNames: file.blocks
			.filter((b): b is Extract<Block, { kind: 'snippet' }> => b.kind === 'snippet')
			.map((b) => b.name),
		placeholders: availablePlaceholders(schema, placeholderContext(file, path)),
		inSnippet: block?.kind === 'snippet',
		holdsDirectives: path.nodes.length ? holdsDirectives(file, parentPath(path)) : holdsDirectives(file, path)
	};
}

/** Replace a site's addresses, keeping the comma style of the existing list (commas by default). */
export function setSiteAddresses(site: SiteBlock, addresses: readonly string[]): void {
	const list = addresses.map((a) => a.trim()).filter(Boolean);
	const hadCommas = site.addresses.length < 2 || site.addresses.some((t) => t.raw?.endsWith(','));
	site.addresses = list.map((a, i) => {
		const tok = createToken(a);
		if (hadCommas && i < list.length - 1) tok.raw = (tok.raw ?? a) + ',';
		return tok;
	});
	delete site.span;
}

/** A deep copy of a node or block, with no spans so nothing points at the old text. */
export function cloneTree<T extends Node | Block>(x: T): T {
	return JSON.parse(JSON.stringify(x)) as T;
}

/** The text of a node as it would appear at the start of a line, for the raw editor; blank lines above it are left out. */
export function rawTextOf(node: Node): string {
	const copy = relayout(cloneTree(node));
	copy.trivia = copy.trivia.filter((t) => t.kind !== 'blank');
	return printNodes([copy], { indent: '' }).replace(/\s+$/, '');
}

/** The blank lines directly above a node (before any comment), so a replacement keeps its spacing. */
export function leadingBlanks(node: Node): Trivia[] {
	const out: Trivia[] = [];
	for (const t of node.trivia) {
		if (t.kind !== 'blank') break;
		out.push(t);
	}
	return out;
}

/** Parse raw text back into nodes, adopting the destination's layout. */
export function nodesFromRaw(text: string, directives: boolean): Node[] {
	return nodesFromText(text, { directives }).map((n) => relayout(n));
}

/** A matcher name not yet used in the body (`@m1`, `@m2`, …), or `@<base>` when free. */
export function uniqueMatcherName(body: readonly Node[], base = 'matcher'): string {
	const used = new Set(matcherNamesIn(body));
	if (!used.has('@' + base)) return '@' + base;
	for (let i = 2; ; i++) if (!used.has(`@${base}${i}`)) return `@${base}${i}`;
}

/** Where a new matcher definition goes: after the last one at the top of the body, else first. */
export function matcherInsertIndex(body: readonly Node[]): number {
	let at = 0;
	for (let i = 0; i < body.length; i++) if (body[i]!.kind === 'matcher') at = i + 1;
	return at;
}

/** Directive names a body can take: HTTP directives in site-like bodies, global options in the global block. */
export function addableNames(schema: SchemaBundle | null, file: Caddyfile, ownerPath: NodePath): string[] {
	const r = resolvePath(file, ownerPath);
	if (!r) return [];
	if (r.block.kind === 'global' && !r.node) return Object.keys(schema?.globalOptions ?? {}).sort();
	if (!r.node || isContainer(r.node)) return Object.keys(schema?.directives ?? {}).sort();
	if (r.node.kind === 'directive') {
		const names = ancestorNames(file, ownerPath);
		let start = 0;
		for (let i = 0; i < names.length - 1; i++) if (CONTAINERS.has(names[i]!)) start = i + 1;
		const s = resolveSchema(
			schema,
			names.slice(start),
			r.block.kind === 'global' ? 'globalOptions' : 'directives'
		);
		return Object.keys(s?.subdirectives ?? {}).sort();
	}
	if (r.node.kind === 'matcher') return Object.keys(schema?.matchers ?? {}).sort();
	return [];
}

export function directiveAt(file: Caddyfile, path: NodePath): Directive | undefined {
	const n = resolvePath(file, path)?.node;
	return n?.kind === 'directive' ? n : undefined;
}
