/**
 * Schema validation for Caddyfile content.
 *
 * Works on a minimal, parser-agnostic node shape so it can run on W1's CST (map
 * `name.text` / `args[].text`) or on anything else that can produce directives.
 * It catches what the schema knows: unknown directives and subdirectives, missing
 * or extra arguments, and malformed values. Caddy's own `/adapt` remains the final
 * authority; this exists to give instant, line-precise feedback in the editors.
 */
import { checkRegexp, checkValue, hasPlaceholder, isMatcherToken } from './grammars.ts';
import type { ArgSchema, DirectiveSchema, MatcherSchema, SchemaBundle } from './types.ts';

export type Severity = 'error' | 'warning' | 'info';

export type Diagnostic = {
	severity: Severity;
	message: string;
	/** Directive names from the block root to the offending node, e.g. ['reverse_proxy', 'transport', 'tls_server_name']. */
	path: string[];
	/** Index into the node's `args` when the problem is a specific argument. */
	argIndex?: number;
	line?: number;
	/** Stable code for UIs and tests. */
	code:
		| 'unknown-directive'
		| 'unknown-subdirective'
		| 'unknown-matcher'
		| 'no-block'
		| 'missing-arg'
		| 'extra-arg'
		| 'bad-value'
		| 'bad-regexp'
		| 'not-allowed-here'
		| 'unknown-global-option'
		| 'undefined-matcher'
		| 'missing-subdirective'
		| 'literal-secret';
};

/** A directive line: name, argument texts (unquoted), optional block. */
export type DirectiveLike = {
	name: string;
	args: string[];
	body?: DirectiveLike[];
	line?: number;
};

/** A block of the Caddyfile. Site addresses are not validated here. */
export type BlockLike = {
	kind: 'global' | 'site' | 'snippet' | 'named_route';
	body: DirectiveLike[];
	name?: string;
	line?: number;
};

type Ctx = {
	schema: SchemaBundle;
	out: Diagnostic[];
	/** Named matchers defined in the enclosing site block. */
	matchers: Set<string>;
	/** Inside a snippet: unknown names are only warnings (snippets can hold anything). */
	lenient: boolean;
};

function diag(ctx: Ctx, d: Omit<Diagnostic, 'severity'> & { severity?: Severity }) {
	ctx.out.push({ ...d, severity: d.severity ?? 'error' });
}

// ---------------------------------------------------------------------------
// Positional arguments

type ArgIssue = { code: Diagnostic['code']; message: string; argIndex?: number; severity?: Severity };

/** Assign tokens to an ArgSchema list: required first, then optionals in order, the variadic takes the rest. */
export function matchArgs(args: ArgSchema[], tokens: string[]): ArgIssue[] {
	const issues: ArgIssue[] = [];
	const required = args.filter((a) => !a.optional).length;
	const optional = args.filter((a) => a.optional && !a.variadic).length;
	const variadicIdx = args.findIndex((a) => a.variadic);
	let spareOptional = Math.max(0, Math.min(optional, tokens.length - required));
	let t = 0;
	for (const [i, a] of args.entries()) {
		if (a.variadic) {
			const restRequired = args.slice(i + 1).filter((x) => !x.optional).length;
			const take = Math.max(0, tokens.length - t - restRequired);
			if (take === 0 && !a.optional) issues.push({ code: 'missing-arg', message: `missing ${a.name}` });
			for (let k = 0; k < take; k++) issues.push(...checkArg(a, tokens[t + k] ?? '', t + k));
			t += take;
			continue;
		}
		if (a.optional) {
			if (spareOptional <= 0 || t >= tokens.length) continue;
			// Skip an optional that the token does not fit when a later optional can take it,
			// e.g. `copy_response [<matcher>] [<status>]` with just `503`.
			// Same for `[private_ranges] <ranges...>`: a later variadic absorbs the token instead.
			const optionalsLeft = args.slice(i).filter((x) => x.optional && !x.variadic).length;
			const laterVariadic = args.slice(i + 1).some((x) => x.variadic);
			if ((optionalsLeft > spareOptional || laterVariadic) && checkArg(a, tokens[t] ?? '', t).length)
				continue;
			spareOptional--;
		} else if (t >= tokens.length) {
			issues.push({ code: 'missing-arg', message: `missing ${a.name}` });
			continue;
		}
		issues.push(...checkArg(a, tokens[t] ?? '', t));
		t++;
	}
	if (t < tokens.length && variadicIdx < 0) {
		issues.push({
			code: 'extra-arg',
			argIndex: t,
			message:
				tokens.length - t === 1
					? `unexpected argument "${tokens[t]}"`
					: `${tokens.length - t} unexpected arguments starting at "${tokens[t]}"`
		});
	}
	return issues;
}

function checkArg(a: ArgSchema, value: string, argIndex: number): ArgIssue[] {
	// A credential written out in the file. The value itself is never repeated in the message.
	if (a.secret && value !== '' && !hasPlaceholder(value)) {
		return [
			{
				code: 'literal-secret',
				message: `this puts the key in the Caddyfile and in History; use ${a.secret} instead`,
				argIndex,
				severity: 'warning'
			}
		];
	}
	if (a.type === 'regexp' && !hasPlaceholder(value)) {
		const err = checkRegexp(value);
		return err ? [{ code: 'bad-regexp', message: `${a.name}: ${err}`, argIndex, severity: 'warning' }] : [];
	}
	const err = checkValue(a.type, value, a);
	return err ? [{ code: 'bad-value', message: `${a.name}: ${err}`, argIndex }] : [];
}

/** Choose the best-fitting form: the one with no issues, else the one whose first enum matches, else the first. */
function matchForms(node: DirectiveSchema | MatcherSchema, tokens: string[]): ArgIssue[] {
	if (!tokens.length && node.args.every((a) => a.optional)) return [];
	const forms = node.forms?.length ? node.forms : [node.args];
	let best: ArgIssue[] | null = null;
	for (const f of forms) {
		const issues = matchArgs(f, tokens);
		if (!issues.length) return [];
		const firstEnum = f[0]?.type === 'enum' && f[0].enum?.includes(tokens[0] ?? '');
		if (firstEnum) return issues;
		if (!best || issues.length < best.length) best = issues;
	}
	return best ?? [];
}

// ---------------------------------------------------------------------------
// Directives and their blocks

function validateNode(ctx: Ctx, schema: DirectiveSchema, node: DirectiveLike, path: string[]) {
	let tokens = node.args;
	const first = tokens[0];
	// Leading matcher token. Like Caddy (root, rewrite), a lone `/path` that the directive needs
	// as its required argument is the argument, not a path matcher.
	const required = schema.args.filter((a) => !a.optional).length;
	const pathIsArg = first !== undefined && first.startsWith('/') && tokens.length <= required;
	if (schema.matcher && first !== undefined && isMatcherToken(first) && !pathIsArg) {
		const m = first;
		if (m.startsWith('@') && !ctx.matchers.has(m) && !ctx.lenient) {
			diag(ctx, {
				code: 'undefined-matcher',
				message: `matcher ${m} is not defined in this site block`,
				path,
				argIndex: 0,
				line: node.line
			});
		}
		tokens = tokens.slice(1);
	}
	const offset = node.args.length - tokens.length;
	// Module variants (transport http, lb_policy cookie, uri strip_prefix, …)
	const moduleName = tokens[0];
	const variant = schema.variants && moduleName !== undefined ? schema.variants[moduleName] : undefined;
	const issues = variant
		? matchForms(variant, tokens.slice(1)).map((i) => shift(i, 1))
		: matchForms(schema, tokens);
	for (const i of issues)
		diag(ctx, {
			code: i.code,
			message: `${schema.name}: ${i.message}`,
			severity: i.severity,
			path,
			line: node.line,
			argIndex: i.argIndex === undefined ? undefined : i.argIndex + offset
		});
	// A module name the schema does not list (lb_policy, issuer, get_certificate, trust_pool, …) is most
	// likely a plugin's; Caddy hands the block to that plugin, so its contents are not ours to judge.
	const pluginModule = !!schema.variants && moduleName !== undefined && !variant;
	if (node.body) validateBody(ctx, schema, variant, node.body, path, pluginModule);
	const owner = variant ?? schema;
	for (const name of owner.requires ?? []) {
		if (node.body?.some((c) => c.name === name)) continue;
		diag(ctx, {
			code: 'missing-subdirective',
			message: `${variant ? `${schema.name} ${owner.name}` : owner.name} needs ${name}`,
			path,
			line: node.line
		});
	}
}

function shift(i: ArgIssue, by: number): ArgIssue {
	return i.argIndex === undefined ? i : { ...i, argIndex: i.argIndex + by };
}

function validateBody(
	ctx: Ctx,
	schema: DirectiveSchema,
	variant: DirectiveSchema | undefined,
	body: DirectiveLike[],
	path: string[],
	pluginModule = false
) {
	if (pluginModule) return;
	const subs = { ...(schema.subdirectives ?? {}), ...(variant?.subdirectives ?? {}) };
	// A chosen module variant defines the block; the host's free-form `{ ... }` only stands for "module options".
	const freeform = variant ? variant.freeformBody : schema.freeformBody;
	const takesBlock =
		schema.block || variant?.block || schema.allowsDirectives || Object.keys(subs).length > 0;
	if (!takesBlock && body.length) {
		diag(ctx, {
			code: 'no-block',
			message: `${schema.name} does not take a block`,
			path,
			line: body[0]?.line
		});
		return;
	}
	if (schema.allowsDirectives) {
		validateDirectives(ctx, body, path, true, schema.subdirectives);
		return;
	}
	for (const child of body) {
		const childPath = [...path, child.name];
		if (child.name.startsWith('@') && schema.allowsResponseMatchers) {
			validateResponseMatcherDef(ctx, child, childPath);
			continue;
		}
		const sub = subs[child.name];
		if (sub) {
			validateNode(ctx, sub, child, childPath);
			continue;
		}
		if (freeform) continue;
		diag(ctx, {
			code: 'unknown-subdirective',
			message: `${schema.name} has no subdirective "${child.name}"`,
			severity: ctx.lenient ? 'warning' : 'error',
			path: childPath,
			line: child.line
		});
	}
}

/**
 * Validate a list of HTTP directives (a site block body, or the body of handle,
 * route, handle_errors, handle_path or handle_response). Named matcher definitions
 * in the list are collected first so directives can use them in any order.
 */
function validateDirectives(
	ctx: Ctx,
	body: DirectiveLike[],
	path: string[],
	nested = false,
	extra?: Record<string, DirectiveSchema>
) {
	const saved = ctx.matchers;
	ctx.matchers = new Set([...saved, ...body.filter((n) => n.name.startsWith('@')).map((n) => n.name)]);
	for (const node of body) {
		const p = [...path, node.name];
		if (node.name.startsWith('@')) {
			validateMatcherDef(ctx, node, p);
			continue;
		}
		const schema = extra?.[node.name] ?? ctx.schema.directives[node.name];
		if (!schema) {
			const onlyIn = findOnlyIn(ctx.schema, node.name);
			if (onlyIn) {
				diag(ctx, {
					code: 'not-allowed-here',
					message: `${node.name} is only allowed inside ${onlyIn}`,
					path: p,
					line: node.line
				});
				continue;
			}
			diag(ctx, {
				code: 'unknown-directive',
				message: `unknown directive "${node.name}" (a plugin directive, or a typo?)`,
				severity: 'warning',
				path: p,
				line: node.line
			});
			continue;
		}
		if (nested && (node.name === 'bind' || node.name === 'tls') && !ctx.lenient) {
			diag(ctx, {
				code: 'not-allowed-here',
				message: `${node.name} belongs at the top level of a site block`,
				severity: 'warning',
				path: p,
				line: node.line
			});
		}
		validateNode(ctx, schema, node, p);
	}
	ctx.matchers = saved;
}

function findOnlyIn(schema: SchemaBundle, name: string): string | undefined {
	const hr = schema.directives.reverse_proxy?.subdirectives?.handle_response?.subdirectives?.[name];
	return hr?.onlyIn?.join(', ');
}

// ---------------------------------------------------------------------------
// Matchers

function validateMatcherDef(ctx: Ctx, node: DirectiveLike, path: string[]) {
	if (node.body) {
		for (const child of node.body)
			validateMatcherLine(ctx, child.name, child.args, child.body, child.line, [...path, child.name]);
		return;
	}
	const [first, ...rest] = node.args;
	if (first === undefined) {
		diag(ctx, {
			code: 'missing-arg',
			message: `${node.name}: a matcher definition needs a matcher or a block`,
			path,
			line: node.line
		});
		return;
	}
	// `@name `expr`` (CEL shorthand) and `@name "expr"` with a single non-matcher token
	if (!ctx.schema.matchers[first] && node.args.length === 1) return;
	validateMatcherLine(ctx, first, rest, undefined, node.line, [...path, first]);
}

function validateMatcherLine(
	ctx: Ctx,
	name: string,
	args: string[],
	body: DirectiveLike[] | undefined,
	line: number | undefined,
	path: string[]
) {
	const m = ctx.schema.matchers[name];
	if (!m) {
		diag(ctx, {
			code: 'unknown-matcher',
			message: `unknown matcher "${name}"`,
			severity: 'warning',
			path,
			line
		});
		return;
	}
	if (name === 'not') {
		if (body)
			for (const c of body) validateMatcherLine(ctx, c.name, c.args, c.body, c.line, [...path, c.name]);
		else if (args[0] !== undefined)
			validateMatcherLine(ctx, args[0], args.slice(1), undefined, line, [...path, args[0]]);
		else diag(ctx, { code: 'missing-arg', message: 'not: missing matcher', path, line });
		return;
	}
	if (body) {
		if (!m.blockForm)
			diag(ctx, { code: 'no-block', message: `matcher ${name} does not take a block`, path, line });
		for (const c of body) {
			const sub = m.subdirectives?.[c.name];
			if (!sub && !m.subdirectives) continue;
			if (!sub)
				diag(ctx, {
					code: 'unknown-subdirective',
					message: `matcher ${name} has no option "${c.name}"`,
					path: [...path, c.name],
					line: c.line
				});
			else
				for (const i of matchForms(sub, c.args))
					diag(ctx, {
						code: i.code,
						message: `${name} ${c.name}: ${i.message}`,
						severity: i.severity,
						path: [...path, c.name],
						line: c.line,
						argIndex: i.argIndex
					});
		}
		return;
	}
	for (const i of matchForms(m, args))
		diag(ctx, {
			code: i.code,
			message: `${name}: ${i.message}`,
			severity: i.severity,
			path,
			line,
			argIndex: i.argIndex
		});
}

function validateResponseMatcherDef(ctx: Ctx, node: DirectiveLike, path: string[]) {
	const [inline, ...inlineArgs] = node.args;
	const lines: DirectiveLike[] =
		node.body ?? (inline !== undefined ? [{ name: inline, args: inlineArgs, line: node.line }] : []);
	for (const l of lines) {
		const m = ctx.schema.responseMatchers[l.name];
		if (!m) {
			diag(ctx, {
				code: 'unknown-matcher',
				message: `unknown response matcher "${l.name}" (expected status or header)`,
				path: [...path, l.name],
				line: l.line
			});
			continue;
		}
		for (const i of matchArgs(m.args, l.args))
			diag(ctx, {
				code: i.code,
				message: `${l.name}: ${i.message}`,
				severity: i.severity,
				path: [...path, l.name],
				line: l.line,
				argIndex: i.argIndex
			});
	}
}

// ---------------------------------------------------------------------------
// Public API

/** Validate one directive as it would appear in a site block. */
export function validateDirective(
	schema: SchemaBundle,
	node: DirectiveLike,
	opts: { definedMatchers?: string[] } = {}
): Diagnostic[] {
	const ctx: Ctx = { schema, out: [], matchers: new Set(opts.definedMatchers ?? []), lenient: false };
	validateDirectives(ctx, [node], []);
	return ctx.out;
}

/** Validate the body of a site block (directives and named matcher definitions). */
export function validateSiteBody(schema: SchemaBundle, body: DirectiveLike[]): Diagnostic[] {
	const ctx: Ctx = { schema, out: [], matchers: new Set(), lenient: false };
	validateDirectives(ctx, body, []);
	return ctx.out;
}

/** Validate the global options block. */
export function validateGlobalOptions(schema: SchemaBundle, body: DirectiveLike[]): Diagnostic[] {
	const ctx: Ctx = { schema, out: [], matchers: new Set(), lenient: false };
	for (const node of body) {
		const opt = schema.globalOptions[node.name];
		if (!opt) {
			diag(ctx, {
				code: 'unknown-global-option',
				message: `unknown global option "${node.name}" (a plugin option, or a typo?)`,
				severity: 'warning',
				path: [node.name],
				line: node.line
			});
			continue;
		}
		validateNode(ctx, opt, node, [node.name]);
	}
	return ctx.out;
}

/** Validate every block of a file. Snippets are checked leniently since they can hold anything. */
export function validateBlocks(schema: SchemaBundle, blocks: BlockLike[]): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (const b of blocks) {
		if (b.kind === 'global') out.push(...validateGlobalOptions(schema, b.body));
		else if (b.kind === 'snippet') {
			const ctx: Ctx = { schema, out: [], matchers: new Set(), lenient: true };
			validateDirectives(ctx, b.body, []);
			out.push(...ctx.out);
		} else out.push(...validateSiteBody(schema, b.body));
	}
	return out;
}
