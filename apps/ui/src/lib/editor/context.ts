/**
 * Where the cursor is in Caddyfile terms: which block and which (sub)directive scope encloses it, and
 * which token of the line it is on. Built from W1's lexer so quotes, heredocs and comments count the
 * same way the parser counts them. Drives autocomplete and hover docs.
 */
import { lex } from '@caddy-ui/caddyfile';
import type { DirectiveSchema, MatcherSchema, SchemaBundle } from '@caddy-ui/caddy-schema/types';

/** What may start a line at the cursor. */
export type Scope =
	| { kind: 'top' }
	| { kind: 'global' }
	/** Site, snippet, named route, or a directive body that holds directives (handle, route, …). */
	| { kind: 'directives'; snippet: boolean }
	/** Subdirectives of a directive, global option or matcher module. */
	| { kind: 'sub'; owner: DirectiveSchema }
	/** Inside `@name { … }` or `not { … }`: matcher modules. */
	| { kind: 'matchers' }
	/** Inside a block the schema does not describe (a plugin directive, free-form rows). */
	| { kind: 'unknown' };

export type CursorContext = {
	scope: Scope;
	/** Tokens of the current line before the cursor, excluding the one being typed. */
	before: string[];
	/** The partial token at the cursor (may be empty) and where it starts. */
	word: string;
	wordFrom: number;
	/** Named matchers (`@name`) defined in the enclosing top-level block. */
	matcherNames: string[];
};

/** The header tokens (without the trailing `{`) of every block open at the end of `text`. */
export function openFrames(text: string): string[][] {
	const stack: string[][] = [];
	for (const line of lex(text).lines) {
		const toks = line.tokens.map((t) => (t.quote === 'none' ? t.text : '\0' + t.text));
		// Closing braces first (`} else {` style lines do not exist in Caddy, but `}` alone does).
		let i = 0;
		while (i < toks.length && toks[i] === '}') {
			stack.pop();
			i++;
		}
		const rest = toks.slice(i);
		if (rest.at(-1) === '{') stack.push(rest.slice(0, -1));
		else if (rest.at(-1) === '{}') {
			/* empty block, opens nothing */
		}
	}
	return stack;
}

const lookup = <T>(rec: Readonly<Record<string, T>> | undefined, key: string | undefined): T | undefined =>
	rec && key !== undefined && Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined;

/** Enter a subdirective or module variant: `transport http {` enters `transport`'s `http` variant. */
function enter(owner: DirectiveSchema | undefined, header: string[]): DirectiveSchema | undefined {
	if (!owner) return undefined;
	return lookup(owner.variants, header[1]) ?? owner;
}

function scopeOfDirective(d: DirectiveSchema | undefined): Scope {
	if (!d) return { kind: 'unknown' };
	if (d.allowsDirectives) return { kind: 'directives', snippet: false };
	if (d.subdirectives || d.variants) return { kind: 'sub', owner: d };
	return { kind: 'unknown' };
}

function matcherScope(m: MatcherSchema | undefined, name: string): Scope {
	if (name === 'not') return { kind: 'matchers' };
	if (m?.subdirectives) {
		return {
			kind: 'sub',
			owner: {
				name: m.name,
				summary: m.summary ?? '',
				docsUrl: m.docsUrl,
				category: 'routing',
				order: -1,
				matcher: false,
				args: m.args,
				subdirectives: m.subdirectives,
				examples: m.examples ?? []
			}
		};
	}
	return { kind: 'unknown' };
}

/** Resolve a stack of block headers to the scope inside the innermost one. */
export function resolveScope(schema: SchemaBundle, frames: string[][]): Scope {
	if (frames.length === 0) return { kind: 'top' };
	const head = frames[0] as string[];
	let scope: Scope;
	if (head.length === 0) scope = { kind: 'global' };
	else if (/^&?\(.+\)$/.test(head[0] as string)) scope = { kind: 'directives', snippet: true };
	else scope = { kind: 'directives', snippet: false };

	for (const header of frames.slice(1)) {
		const name = header[0] ?? '';
		switch (scope.kind) {
			case 'global': {
				const opt = enter(lookup(schema.globalOptions, name), header);
				scope = opt ? { kind: 'sub', owner: opt } : { kind: 'unknown' };
				break;
			}
			case 'directives': {
				if (name.startsWith('@')) scope = { kind: 'matchers' };
				else scope = scopeOfDirective(enter(lookup(schema.directives, name), header));
				break;
			}
			case 'sub': {
				if (name.startsWith('@') && scope.owner.allowsResponseMatchers) {
					scope = { kind: 'unknown' };
					break;
				}
				const sub = enter(lookup(scope.owner.subdirectives, name), header);
				scope = sub ? scopeOfDirective(sub) : { kind: 'unknown' };
				// A subdirective with a body but no schema'd children (e.g. `servers { … }` options) stays 'sub'.
				if (sub && scope.kind === 'unknown' && (sub.subdirectives || sub.variants))
					scope = { kind: 'sub', owner: sub };
				break;
			}
			case 'matchers':
				scope = matcherScope(lookup(schema.matchers, name), name);
				break;
			default:
				scope = { kind: 'unknown' };
		}
	}
	return scope;
}

/** Named matchers defined in the top-level block that contains `pos`. */
export function matcherNamesAround(text: string, pos: number): string[] {
	// Find the enclosing top-level block by scanning line starts at column 0 that open a block.
	const lines = text.split('\n');
	let offset = 0;
	let start = 0;
	let end = text.length;
	for (const line of lines) {
		if (/^\S.*\{\s*(#.*)?$/.test(line) || /^\{\s*$/.test(line)) {
			if (offset <= pos) start = offset;
			else {
				end = offset;
				break;
			}
		}
		offset += line.length + 1;
	}
	const names = new Set<string>();
	for (const m of text.slice(start, end).matchAll(/^[ \t]*(@[^\s{}]+)/gm)) names.add(m[1] as string);
	return [...names];
}

export function cursorContext(schema: SchemaBundle, text: string, pos: number): CursorContext {
	const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
	const frames = openFrames(text.slice(0, lineStart));
	const scope = resolveScope(schema, frames);
	const lineText = text.slice(lineStart, pos);
	// The current line, lexed on its own; a quote opened earlier on the line is rare enough to ignore.
	const lexed = lex(lineText).lines.flatMap((l) => l.tokens);
	let word = '';
	let wordFrom = pos;
	let before = lexed.map((t) => t.text);
	const last = lexed.at(-1);
	if (last?.span && last.span.end === lineText.length && !/\s$/.test(lineText)) {
		word = last.raw ?? last.text;
		wordFrom = lineStart + last.span.start;
		before = before.slice(0, -1);
	}
	// `} handle {` is not Caddy syntax, but a leading `}` closes a block before the cursor's tokens.
	while (before[0] === '}') before.shift();
	return { scope, before, word, wordFrom, matcherNames: matcherNamesAround(text, pos) };
}

/** The schema node a line's first token names in a scope, if any. */
export function schemaFor(
	schema: SchemaBundle,
	scope: Scope,
	name: string
):
	| { kind: 'directive' | 'option' | 'subdirective'; node: DirectiveSchema }
	| { kind: 'matcher'; node: MatcherSchema }
	| null {
	switch (scope.kind) {
		case 'directives': {
			const d = lookup(schema.directives, name);
			return d ? { kind: 'directive', node: d } : null;
		}
		case 'global': {
			const g = lookup(schema.globalOptions, name);
			return g ? { kind: 'option', node: g } : null;
		}
		case 'sub': {
			const s = lookup(scope.owner.subdirectives, name);
			return s ? { kind: 'subdirective', node: s } : null;
		}
		case 'matchers': {
			const m = lookup(schema.matchers, name);
			return m ? { kind: 'matcher', node: m } : null;
		}
		default:
			return null;
	}
}

/** Escape a placeholder catalogue name (`{path.N}`, `{header.*}`) into a regexp matching real uses. */
export function placeholderPattern(name: string): RegExp {
	const body = name
		.slice(1, -1)
		.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		.replace(/\\\*/g, '.+')
		.replace(/\bN\b/g, '\\d+')
		.replace(/\bn:m\b/g, '\\d*:\\d*')
		.replace(/\bVAR\b/g, '[A-Za-z0-9_]+')
		.replace(/:default/g, '(:[^}]*)?')
		.replace(/\bname\b/g, '[^.}]+')
		.replace(/\bField\b/g, '[^.}]+');
	return new RegExp(`^\\{${body}\\}$`);
}

/** The catalogue entry that documents a concrete placeholder such as `{path.1}` or `{header.X-Foo}`. */
export function findPlaceholder(schema: SchemaBundle, text: string) {
	const exact = schema.placeholders.find((p) => p.name === text);
	if (exact) return exact;
	if (/^\{\$[A-Za-z0-9_]+(:[^}]*)?\}$/.test(text))
		return schema.placeholders.find((p) => p.name === (text.includes(':') ? '{$VAR:default}' : '{$VAR}'));
	// Most specific first: `{path.N}` before `{path.*}`.
	const candidates = schema.placeholders
		.filter((p) => p.parameterized)
		.sort((a, b) => Number(a.name.includes('*')) - Number(b.name.includes('*')));
	return candidates.find((p) => placeholderPattern(p.name).test(text));
}
