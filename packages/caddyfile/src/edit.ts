import { parseFragment } from './parser.js';
import { quoteToken } from './printer.js';
import type {
	Block,
	Caddyfile,
	Directive,
	MatcherDef,
	MatcherKind,
	MatcherRef,
	Node,
	ParseOptions,
	SiteBlock,
	SnippetBlock,
	Token,
	Trivia
} from './types.js';

/**
 * Helpers for building and changing trees. The tree is plain data, so callers
 * may also edit it directly; these functions keep the invariants the printer
 * relies on (a token's `raw` matches its `text`, edited nodes drop stale
 * layout so they are re-indented in the file's style).
 */

/** Create a token from a value, choosing the quoting Caddy needs for it. */
export function createToken(text: string): Token {
	const raw = quoteToken(text);
	const quote: Token['quote'] =
		raw === text ? 'none' : raw.startsWith('"') ? 'double' : raw.startsWith('`') ? 'backtick' : 'heredoc';
	const tok: Token = { text, raw, quote };
	if (quote === 'heredoc') tok.heredocMarker = raw.slice(2, raw.indexOf('\n'));
	return tok;
}

/** Change a token's value in place, re-deriving its source form. */
export function setTokenText(tok: Token, text: string): Token {
	const fresh = createToken(text);
	tok.text = fresh.text;
	tok.raw = fresh.raw;
	tok.quote = fresh.quote;
	delete tok.span;
	if (fresh.heredocMarker) tok.heredocMarker = fresh.heredocMarker;
	else delete tok.heredocMarker;
	return tok;
}

export function matcherKindOf(text: string): MatcherKind | undefined {
	if (text.startsWith('@')) return 'named';
	if (text === '*') return 'all';
	if (text.startsWith('/')) return 'path';
	return undefined;
}

export function createMatcherRef(text: string): MatcherRef {
	const kind = matcherKindOf(text);
	if (!kind) throw new Error(`'${text}' is not a matcher token (expected @name, /path or *)`);
	return { ...createToken(text), matcherKind: kind };
}

export interface CreateDirectiveOptions {
	matcher?: string;
	body?: Node[];
	/** Comment lines (without `#`, or with) to place above the directive. */
	comments?: string[];
}

export function createDirective(
	name: string,
	args: readonly string[] = [],
	opts: CreateDirectiveOptions = {}
): Directive {
	const d: Directive = {
		kind: 'directive',
		name: createToken(name),
		args: args.map(createToken),
		trivia: (opts.comments ?? []).map(createComment)
	};
	if (opts.matcher !== undefined) d.matcher = createMatcherRef(opts.matcher);
	if (opts.body) d.body = opts.body;
	return d;
}

/** `@name <module> <args...>` or, with `body`, the block form. */
export function createMatcherDef(
	name: string,
	inline?: { module: string; args?: readonly string[] },
	body?: Node[]
): MatcherDef {
	const n = name.startsWith('@') ? name : '@' + name;
	const def: MatcherDef = { kind: 'matcher', name: createToken(n), trivia: [] };
	if (body) def.body = body;
	else if (inline) {
		def.inline = {
			kind: 'directive',
			name: createToken(inline.module),
			args: (inline.args ?? []).map(createToken),
			trivia: []
		};
	}
	return def;
}

/** `@name \`<cel expression>\``: the CEL shorthand. */
export function createCelMatcherDef(name: string, expression: string): MatcherDef {
	const n = name.startsWith('@') ? name : '@' + name;
	const raw = expression.includes('`') ? quoteToken(expression) : '`' + expression + '`';
	const tok: Token = {
		text: expression,
		raw,
		quote: raw.startsWith('`') ? 'backtick' : raw.startsWith('"') ? 'double' : 'heredoc'
	};
	return {
		kind: 'matcher',
		name: createToken(n),
		trivia: [],
		inline: { kind: 'directive', name: tok, args: [], trivia: [] }
	};
}

/** True when a matcher definition is the one-token CEL shorthand (`@name \`expr\``). */
export function isCelShorthand(def: MatcherDef): boolean {
	return def.inline !== undefined && def.inline.args.length === 0 && def.inline.name.quote !== 'none';
}

export function createComment(text: string): Trivia {
	const t = text.startsWith('#') ? text : '# ' + text;
	return { kind: 'comment', text: t };
}

export function createBlank(): Trivia {
	return { kind: 'blank', text: '' };
}

export function createSite(
	addresses: readonly string[],
	body: Node[] = [],
	comments: string[] = []
): SiteBlock {
	return {
		kind: 'site',
		addresses: addresses.map(createToken),
		body,
		trivia: comments.map(createComment)
	};
}

export function createSnippet(name: string, body: Node[] = []): SnippetBlock {
	return { kind: 'snippet', name, nameToken: createToken(`(${name})`), body, trivia: [] };
}

/**
 * Build body nodes from Caddyfile text, e.g. a recipe template or the text of
 * a raw row in the visual editor. The nodes keep the relative layout of the
 * text; call {@link relayout} on them to adopt the destination file's style.
 */
export function nodesFromText(text: string, opts: ParseOptions & { directives?: boolean } = {}): Node[] {
	return parseFragment(text, opts).nodes;
}

/**
 * Forget the stored whitespace of a node (and, with `deep`, of its body) so
 * the printer re-indents it in the surrounding style. Comments are kept.
 * Call this after moving a node to a different depth.
 */
export function relayout<T extends Node | Block>(target: T, deep = true): T {
	const strip = (node: Node): void => {
		const keep = node.layout;
		const layout: NonNullable<Node['layout']> = {};
		if (keep?.trailing && keep.trailing.includes('#')) layout.trailing = ' ' + keep.trailing.trim();
		if (keep?.closeTrailing && keep.closeTrailing.includes('#'))
			layout.closeTrailing = ' ' + keep.closeTrailing.trim();
		if (keep?.innerTrivia) layout.innerTrivia = keep.innerTrivia.map(stripTrivia);
		if (keep?.braceStyle === 'empty') layout.braceStyle = 'empty';
		if (Object.keys(layout).length) node.layout = layout;
		else delete node.layout;
		node.trivia = node.trivia.map(stripTrivia);
		const tokens: Token[] =
			node.kind === 'raw'
				? node.tokens
				: node.kind === 'directive'
					? [node.name, ...(node.matcher ? [node.matcher] : []), ...node.args]
					: [node.name, ...(node.inline ? [node.inline.name, ...node.inline.args] : [])];
		for (const t of tokens) delete t.leading;
		if (deep && node.body) node.body.forEach(strip);
		if (deep && node.kind === 'matcher' && node.inline?.body) node.inline.body.forEach(strip);
	};
	if (
		'kind' in target &&
		(target.kind === 'directive' ||
			target.kind === 'matcher' ||
			(target.kind === 'raw' && 'tokens' in target))
	) {
		strip(target as Node);
		return target;
	}
	const block = target as Block;
	block.trivia = block.trivia.map(stripTrivia);
	if (block.kind === 'import' || block.kind === 'raw') {
		strip(block.node);
		return target;
	}
	const keep = block.layout;
	const layout: NonNullable<Block['layout']> = {};
	if (keep?.trailing && keep.trailing.includes('#')) layout.trailing = ' ' + keep.trailing.trim();
	if (keep?.closeTrailing && keep.closeTrailing.includes('#'))
		layout.closeTrailing = ' ' + keep.closeTrailing.trim();
	if (keep?.innerTrivia) layout.innerTrivia = keep.innerTrivia.map(stripTrivia);
	if (keep?.braceStyle === 'empty') layout.braceStyle = 'empty';
	if (Object.keys(layout).length) block.layout = layout;
	else delete block.layout;
	if (block.kind === 'site') {
		for (const a of block.addresses) {
			if (a.leading !== undefined && !/[\r\n#]/.test(a.leading)) delete a.leading;
		}
	}
	if (deep) block.body.forEach(strip);
	return target;
}

function stripTrivia(t: Trivia): Trivia {
	return t.kind === 'comment'
		? { kind: 'comment', text: t.text.replace(/[ \t]+$/, '') }
		: { kind: 'blank', text: '' };
}

/** Insert a node into a body at `index` (default: end). Returns the node. */
export function insertNode<T extends Node>(body: Node[], node: T, index = body.length): T {
	body.splice(index, 0, node);
	return node;
}

/** Remove a node from a body. Returns true when it was found. */
export function removeNode(body: Node[], node: Node): boolean {
	const i = body.indexOf(node);
	if (i < 0) return false;
	body.splice(i, 1);
	return true;
}

/** Replace a node in a body with another one, moving the leading comments over. */
export function replaceNode(body: Node[], oldNode: Node, newNode: Node): boolean {
	const i = body.indexOf(oldNode);
	if (i < 0) return false;
	if (newNode.trivia.length === 0) newNode.trivia = oldNode.trivia;
	body[i] = newNode;
	return true;
}

export function insertBlock(file: Caddyfile, block: Block, index = file.blocks.length): Block {
	// keep one blank line between top-level blocks, as people write them
	if (index > 0 && block.trivia[0]?.kind !== 'blank') block.trivia = [createBlank(), ...block.trivia];
	file.blocks.splice(index, 0, block);
	return block;
}

export function removeBlock(file: Caddyfile, block: Block): boolean {
	const i = file.blocks.indexOf(block);
	if (i < 0) return false;
	file.blocks.splice(i, 1);
	// if the next block now starts with the removed block's spacing, keep a single blank line
	return true;
}

/** Set the positional arguments of a directive from plain values. */
export function setArgs(directive: Directive, args: readonly string[]): Directive {
	directive.args = args.map(createToken);
	delete directive.span;
	return directive;
}

export function setMatcher(directive: Directive, matcher: string | undefined): Directive {
	if (matcher === undefined) delete directive.matcher;
	else directive.matcher = createMatcherRef(matcher);
	return directive;
}
