/**
 * Parses the syntax skeletons the Caddy docs print in `caddy-d` blocks, e.g.
 *
 *   reverse_proxy [<matcher>] [<upstreams...>] {
 *       to <upstreams...>
 *       header_up [+|-]<field> [<value|regexp> [<replacement>]]
 *   }
 *
 * into a tree of lines, and turns each line's argument notation into ArgSchema
 * entries.
 */
import type { ArgSchema } from '../src/types.ts';
import { inferType } from './infer.ts';

export type SyntaxNode = {
	/** The line as printed (comments removed, whitespace collapsed). */
	text: string;
	tokens: string[];
	children?: SyntaxNode[];
	/** A `#` comment on the line or the line(s) just above it. */
	comment?: string;
};

/** Split a syntax line on whitespace, keeping `[…]` and `<…>` groups together. */
export function tokenize(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let square = 0;
	let angle = 0;
	let quote = false;
	for (let idx = 0; idx < line.length; idx++) {
		const ch = line[idx];
		if (ch === '"') quote = !quote;
		if (!quote) {
			if (ch === '[') square++;
			else if (ch === ']') square = Math.max(0, square - 1);
			else if (ch === '<' && /[A-Za-z_{]/.test(line[idx + 1] ?? '')) angle++;
			else if (ch === '>' && angle > 0) angle--;
		}
		if (/\s/.test(ch) && square === 0 && angle === 0 && !quote) {
			if (cur) out.push(cur);
			cur = '';
			continue;
		}
		cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

/** Parse a syntax code block into a tree of lines. */
export function parseSyntaxBlock(text: string): SyntaxNode[] {
	const root: SyntaxNode = { text: '', tokens: [], children: [] };
	const stack: SyntaxNode[] = [root];
	let pendingComment: string[] = [];
	for (const rawLine of text.split('\n')) {
		let line = rawLine.trim();
		if (!line) {
			pendingComment = [];
			continue;
		}
		if (line.startsWith('#')) {
			pendingComment.push(line.replace(/^#\s*/, ''));
			continue;
		}
		let comment: string | undefined;
		const hash = line.search(/\s#\s/);
		if (hash >= 0) {
			comment = line.slice(hash).replace(/^\s*#\s*/, '');
			line = line.slice(0, hash).trim();
		}
		if (line === '}') {
			if (stack.length > 1) stack.pop();
			pendingComment = [];
			continue;
		}
		const tokens = tokenize(line);
		let opens = false;
		if (tokens[tokens.length - 1] === '{') {
			tokens.pop();
			opens = true;
		} else if (
			tokens.length &&
			tokens[tokens.length - 1].endsWith('{') &&
			!tokens[tokens.length - 1].startsWith('[')
		) {
			tokens[tokens.length - 1] = tokens[tokens.length - 1].slice(0, -1);
			opens = true;
		}
		// `{ }` on one line (e.g. `extensions { … }`) is treated as an empty block.
		const node: SyntaxNode = { text: tokens.join(' '), tokens };
		const c = [...pendingComment, ...(comment ? [comment] : [])].join(' ').trim();
		if (c) node.comment = c;
		pendingComment = [];
		const parent = stack[stack.length - 1];
		(parent.children ??= []).push(node);
		if (opens) {
			node.children = [];
			stack.push(node);
		}
	}
	return root.children ?? [];
}

export type ParsedArgs = {
	args: ArgSchema[];
	/** `[<matcher>]` was present. */
	matcher: boolean;
	/** `[{block}]` was present. */
	block: boolean;
	/** The line ends in `...` (module name plus free-form module config, which may include a block). */
	moduleTail: boolean;
};

const PLACEHOLDER = /^<([^<>]+)>$/;

function stripVariadic(name: string): { name: string; variadic: boolean } {
	const variadic = name.endsWith('...');
	return { name: variadic ? name.slice(0, -3) : name, variadic };
}

/** Normalise a docs argument name: `php-fpm_gateways` → `php_fpm_gateways`, `value|regexp` → `value`. */
export function normaliseArgName(name: string): string {
	return name
		.split('|')[0]
		.replace(/[^A-Za-z0-9_]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase();
}

/** Split on `|` that is not inside `<…>` or `[…]`. */
function splitAlternatives(tok: string): string[] {
	const parts: string[] = [];
	let cur = '';
	let depth = 0;
	for (const ch of tok) {
		if (ch === '<' || ch === '[') depth++;
		if (ch === '>' || ch === ']') depth--;
		if (ch === '|' && depth === 0) {
			parts.push(cur);
			cur = '';
			continue;
		}
		cur += ch;
	}
	parts.push(cur);
	return parts.filter((p) => p !== '');
}

/**
 * Turn the argument tokens of one syntax line (everything after the name) into
 * ArgSchema entries. Docs come from `docFor` (bullet text keyed by arg name).
 */
export function parseArgs(
	tokens: string[],
	docFor: (name: string) => string,
	context: string,
	optional = false
): ParsedArgs {
	const result: ParsedArgs = { args: [], matcher: false, block: false, moduleTail: false };
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === '[<matcher>]') {
			result.matcher = true;
			continue;
		}
		if (tok === '[{block}]' || tok === '{block}') {
			result.block = true;
			continue;
		}
		if (tok === '...' || tok === '[...]') {
			result.moduleTail = true;
			const prev = result.args[result.args.length - 1];
			if (prev && !prev.variadic && prev.type !== 'enum') prev.variadic = true;
			else
				result.args.push({
					name: 'options',
					type: 'string',
					optional: true,
					variadic: true,
					doc: 'Further arguments for the chosen module.'
				});
			continue;
		}
		if (tok === '|') continue; // alternative forms (tls); refined by overrides
		if (tok.startsWith('[') && tok.endsWith(']')) {
			const inner = tok.slice(1, -1);
			const innerTokens = tokenize(inner);
			const sub = parseArgs(innerTokens, docFor, context, true);
			result.matcher ||= sub.matcher;
			result.block ||= sub.block;
			result.moduleTail ||= sub.moduleTail;
			result.args.push(...sub.args);
			continue;
		}
		result.args.push(parseOne(tok, docFor, context, optional));
	}
	return result;
}

function parseOne(
	tok: string,
	docFor: (name: string) => string,
	context: string,
	optional: boolean
): ArgSchema {
	let prefixes: string[] | undefined;
	let body = tok;
	let trailingVariadic = false;
	if (body.endsWith('>...')) {
		body = body.slice(0, -3);
		trailingVariadic = true;
	}
	const pre = /^\[([+\-?>~<|]+)\](.+)$/.exec(body) ?? /^([+\-?>~<])(<.+>)$/.exec(body);
	if (pre) {
		prefixes = pre[1].split('|').filter(Boolean);
		body = pre[2];
	}
	const parts = splitAlternatives(body);
	const placeholders: { name: string; variadic: boolean }[] = [];
	const literals: string[] = [];
	for (const p of parts) {
		const m = PLACEHOLDER.exec(p);
		if (m) placeholders.push(stripVariadic(m[1]));
		else literals.push(p.replace(/^"|"$/g, ''));
	}
	let arg: ArgSchema;
	if (placeholders.length === 0) {
		const name = literals.length === 1 ? normaliseArgName(literals[0]) : 'value';
		arg = { name, type: 'enum', enum: literals, doc: '' };
	} else {
		const rawName = placeholders.map((p) => p.name).join('|');
		const name = normaliseArgName(placeholders[0].name);
		arg = {
			name,
			type: inferType(placeholders[0].name, context),
			doc: docFor(rawName) || docFor(placeholders[0].name)
		};
		if (placeholders.length > 1) {
			arg.name = placeholders.map((p) => normaliseArgName(p.name)).join('_or_');
			const types = new Set(placeholders.map((p) => inferType(p.name, context)));
			arg.type = types.size === 1 ? [...types][0] : 'string';
			arg.doc = placeholders
				.map((p) => docFor(p.name))
				.filter(Boolean)
				.join(' ');
		}
		if (trailingVariadic || placeholders.some((p) => p.variadic)) arg.variadic = true;
		if (literals.length) arg.literals = literals;
	}
	if (prefixes) arg.prefixes = prefixes;
	if (optional) arg.optional = true;
	return arg;
}
