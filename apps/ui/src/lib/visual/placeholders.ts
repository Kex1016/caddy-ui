/**
 * Which placeholders make sense where the selected node sits: the HTTP set everywhere in a site,
 * `{err.*}` inside handle_errors, `{rp.*}` inside handle_response, `{args[N]}` in a snippet, and
 * `{re.name.N}` / `{re.N}` only when a regexp matcher in the block defines the captures.
 */
import type { Block, Caddyfile, Node } from '@caddy-ui/caddyfile';
import type { PlaceholderSchema, SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { resolvePath, type NodePath } from './document';
import { captureGroups } from './matcher';

export type PlaceholderContext = {
	block: Block['kind'] | null;
	inErrors: boolean;
	inResponseHandler: boolean;
	inSnippet: boolean;
	/** Captures defined by named `path_regexp` / `header_regexp` matchers in the block. */
	captures: { name: string | null; count: number; names: string[] }[];
};

const CONTAINER = new Set(['handle', 'route', 'handle_path', 'handle_errors']);

function regexpModules(body: readonly Node[], out: PlaceholderContext['captures']): void {
	for (const n of body) {
		if (n.kind === 'matcher') {
			const mods = n.inline ? [n.inline] : (n.body ?? []).filter((x) => x.kind === 'directive');
			for (const m of mods) {
				if (m.kind !== 'directive') continue;
				if (m.name.text !== 'path_regexp' && m.name.text !== 'header_regexp' && m.name.text !== 'vars_regexp')
					continue;
				// path_regexp [<name>] <regexp>; header_regexp [<name>] <field> <regexp>; vars_regexp [<name>] <var> <regexp>
				// Without an explicit name Caddy (2.8+) uses the named matcher's name: @user path_regexp … → {re.user.1}
				const fixed = m.name.text === 'path_regexp' ? 1 : 2;
				const named = m.args.length > fixed;
				const name = named ? (m.args[0]?.text ?? null) : n.name.text.replace(/^@/, '');
				const re = m.args[m.args.length - 1]?.text ?? '';
				const g = captureGroups(re);
				out.push({ name, count: g.count, names: g.names });
			}
		} else if (n.kind === 'directive' && n.body && CONTAINER.has(n.name.text)) regexpModules(n.body, out);
	}
}

export function placeholderContext(file: Caddyfile, path: NodePath): PlaceholderContext {
	const r = resolvePath(file, path);
	const ctx: PlaceholderContext = {
		block: r?.block.kind ?? null,
		inErrors: false,
		inResponseHandler: false,
		inSnippet: r?.block.kind === 'snippet',
		captures: []
	};
	if (!r) return ctx;
	// Walk the ancestors (the path prefixes) to see which containers enclose the node.
	for (let i = 1; i <= path.nodes.length; i++) {
		const a = resolvePath(file, { block: path.block, nodes: path.nodes.slice(0, i) });
		const n = a?.node;
		if (n?.kind !== 'directive') continue;
		if (n.name.text === 'handle_errors') ctx.inErrors = true;
		if (
			n.name.text === 'handle_response' ||
			n.name.text === 'copy_response' ||
			n.name.text === 'copy_response_headers'
		)
			ctx.inResponseHandler = true;
	}
	if (r.block.kind === 'site' || r.block.kind === 'snippet' || r.block.kind === 'named_route')
		regexpModules(r.block.body, ctx.captures);
	return ctx;
}

export type PlaceholderChoice = { name: string; doc: string; group: string };

/** The list the picker shows for a context, concrete captures first, then the catalogue by scope. */
export function availablePlaceholders(
	schema: SchemaBundle | null,
	ctx: PlaceholderContext
): PlaceholderChoice[] {
	const out: PlaceholderChoice[] = [];
	const seen = new Set<string>();
	const add = (name: string, doc: string) => {
		if (seen.has(name)) return;
		seen.add(name);
		out.push({ name, doc, group: 'Captures' });
	};
	for (const c of ctx.captures) {
		for (let i = 1; i <= c.count; i++)
			add(`{re.${c.name}.${i}}`, `Capture group ${i} of the ${c.name} regexp`);
		for (const n of c.names) add(`{re.${c.name}.${n}}`, `Named capture "${n}" of the ${c.name} regexp`);
	}
	for (const c of ctx.captures)
		for (let i = 1; i <= c.count; i++)
			add(`{re.${i}}`, `Capture group ${i} of the last regexp matcher that ran`);
	const scopes = new Set<PlaceholderSchema['scope']>(['http', 'global']);
	if (ctx.inErrors) scopes.add('error');
	if (ctx.inResponseHandler) scopes.add('reverse_proxy');
	if (ctx.inSnippet) scopes.add('snippet');
	scopes.add('tls');
	const groupOf = (p: PlaceholderSchema): string => {
		if (p.scope === 'snippet') return 'Snippet arguments';
		if (p.scope === 'error') return 'Error';
		if (p.scope === 'reverse_proxy') return 'Upstream response';
		if (p.scope === 'tls') return 'TLS client';
		if (p.scope === 'global') return 'System';
		return p.name.startsWith('{http.') ? 'Request (long form)' : 'Request';
	};
	const rank = (p: PlaceholderSchema) =>
		p.scope === 'snippet' && ctx.inSnippet
			? 0
			: p.scope === 'error'
				? 1
				: p.scope === 'reverse_proxy'
					? 2
					: p.scope === 'http'
						? p.name.startsWith('{http.')
							? 5
							: 3
						: p.scope === 'global'
							? 6
							: 7;
	const list = (schema?.placeholders ?? [])
		.filter((p) => scopes.has(p.scope))
		// parameterised regexp captures are replaced by the concrete ones above; `{re.*}` stays only without captures
		.filter((p) => !(p.name.startsWith('{re.') && ctx.captures.length))
		.filter((p) => p.scope !== 'matcher')
		.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	for (const p of list) out.push({ name: p.name, doc: p.doc, group: groupOf(p) });
	return out;
}
