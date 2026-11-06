/**
 * @caddy-ui/caddy-schema — every standard Caddyfile directive, matcher, global
 * option and placeholder, generated from the Caddy docs (see docs-source.json for
 * the commit) plus hand-curated corrections in scripts/overrides.ts.
 */
import bundleJson from './generated/schema.json' with { type: 'json' };
import type {
	DirectiveSchema,
	GlobalOptionSchema,
	MatcherSchema,
	PlaceholderSchema,
	SchemaBundle
} from './types.ts';

export * from './types.ts';
export * from './grammars.ts';
export * from './validate.ts';

/** The full schema bundle (what `GET /api/schema` serves). */
export const schema: SchemaBundle = bundleJson as unknown as SchemaBundle;

export const directives: Readonly<Record<string, DirectiveSchema>> = schema.directives;
export const matchers: Readonly<Record<string, MatcherSchema>> = schema.matchers;
export const responseMatchers: Readonly<Record<string, MatcherSchema>> = schema.responseMatchers;
export const globalOptions: Readonly<Record<string, GlobalOptionSchema>> = schema.globalOptions;
export const placeholders: readonly PlaceholderSchema[] = schema.placeholders;
/** Caddy's default directive order (including copy_response and copy_response_headers). */
export const defaultOrder: readonly string[] = schema.defaultOrder;

/** A short version string for caching: schema version + docs commit. */
export const schemaVersion = `${schema.schemaVersion}-${schema.source.commit.slice(0, 12)}`;

export function getDirective(name: string): DirectiveSchema | undefined {
	return Object.prototype.hasOwnProperty.call(directives, name) ? directives[name] : undefined;
}

export function getMatcher(name: string): MatcherSchema | undefined {
	return Object.prototype.hasOwnProperty.call(matchers, name) ? matchers[name] : undefined;
}

export function getGlobalOption(name: string): GlobalOptionSchema | undefined {
	return Object.prototype.hasOwnProperty.call(globalOptions, name) ? globalOptions[name] : undefined;
}

/**
 * Walk into a directive by path, e.g. ['reverse_proxy', 'transport', 'http', 'tls_server_name'].
 * A step that names a module variant (`http` under `transport`) enters the variant.
 */
export function resolvePath(
	path: readonly string[],
	root: Readonly<Record<string, DirectiveSchema>> = directives
): DirectiveSchema | undefined {
	const [head] = path;
	if (head === undefined) return undefined;
	let cur: DirectiveSchema | undefined = root[head];
	for (const step of path.slice(1)) {
		if (!cur) return undefined;
		cur = cur.subdirectives?.[step] ?? cur.variants?.[step];
	}
	return cur;
}

/**
 * The position of a directive in Caddy's default order, or -1 for directives that
 * are not ordered (plugins without an `order` option, `import`, `bind`, `tls`, …).
 * `customOrder` applies `order` global options: [directive, 'first'|'last'|'before'|'after', other?].
 */
export function effectiveOrder(
	customOrder: readonly (readonly [directive: string, position: string, other?: string])[] = []
): string[] {
	const order = [...defaultOrder];
	for (const [dir, pos, other] of customOrder) {
		const i = order.indexOf(dir);
		if (i >= 0) order.splice(i, 1);
		if (pos === 'first') order.unshift(dir);
		else if (pos === 'last') order.push(dir);
		else if ((pos === 'before' || pos === 'after') && other) {
			const j = order.indexOf(other);
			if (j < 0) order.push(dir);
			else order.splice(pos === 'before' ? j : j + 1, 0, dir);
		}
	}
	return order;
}

/** Find placeholders whose name starts with `prefix` (with or without the brace), for autocomplete. */
export function searchPlaceholders(prefix: string, scope?: PlaceholderSchema['scope']): PlaceholderSchema[] {
	const p = prefix.startsWith('{') ? prefix : `{${prefix}`;
	return placeholders.filter(
		(x) => x.name.startsWith(p) && (!scope || x.scope === scope || x.scope === 'global')
	);
}
