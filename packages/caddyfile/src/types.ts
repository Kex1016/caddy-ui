/**
 * Concrete syntax tree for Caddyfiles.
 *
 * The tree is lossless: `print(parse(text)) === text` for any input, including
 * invalid Caddyfiles. Everything the printer needs to reproduce the source is
 * stored on the nodes themselves (token raw text, inter-token whitespace,
 * indentation, newlines, comments), so the tree never has to keep a reference
 * to the original string.
 *
 * Nodes that are created or edited by hand may leave the layout fields out; the
 * printer then synthesises whitespace in the style of the surrounding file.
 */

/** Half-open character offset range `[start, end)` into the source text. */
export interface Span {
	start: number;
	end: number;
}

export type Quote = 'none' | 'double' | 'backtick' | 'heredoc';

export interface Token {
	/** Decoded value: quotes removed, `\"` unescaped, heredoc indentation stripped. */
	text: string;
	/**
	 * Exact source text of the token, including quotes or heredoc markers.
	 * This is what the printer writes. Synthesised tokens may omit it and the
	 * printer derives it from `text` with {@link quoteToken}.
	 */
	raw?: string;
	quote: Quote;
	/** Present on parsed tokens, absent on synthesised ones. */
	span?: Span;
	/**
	 * Source text between the previous token on the same logical line and this
	 * one: spaces, tabs, `\`-newline line continuations and, for site addresses
	 * that continue on the next line after a comma, the newline and any comment.
	 * Undefined means "one space" (or nothing for the first token of a line).
	 */
	leading?: string;
	/** Heredoc marker without the `<<`, for `quote === 'heredoc'`. */
	heredocMarker?: string;
}

export type MatcherKind = 'named' | 'path' | 'all';

/** A matcher token in argument position: `@name`, `/path*` or `*`. */
export interface MatcherRef extends Token {
	matcherKind: MatcherKind;
}

/** A comment line or a blank line, outside of any token. */
export interface Trivia {
	kind: 'comment' | 'blank';
	/** Comment text including the leading `#`; empty string for blank lines. */
	text: string;
	span?: Span;
	/** Whitespace before the comment (for blank lines: the whole line content). */
	indent?: string;
	newline?: string;
}

/** How a `{ ... }` block was written. */
export type BraceStyle =
	/** `{` ends the line, `}` is on its own line. The default. */
	| 'block'
	/** `{` and `}` on the same line with only whitespace between: `handle { }`. Empty bodies only. */
	| 'inline'
	/** A single `{}` token. Empty bodies only. */
	| 'empty';

/**
 * Whitespace and comments around one line-shaped construct (a directive line,
 * a matcher definition, a block header). Every field is optional so that
 * synthesised nodes can leave it out entirely.
 */
export interface Layout {
	/** Whitespace before the first token. */
	indent?: string;
	/** Text after the last token of the opening line up to the newline: whitespace and an optional `# comment`. */
	trailing?: string;
	/** Line terminator of the opening line: `\n`, `\r\n` or `''` at end of file. */
	newline?: string;
	/** Whitespace before the `{`; only when the node has a body. */
	braceLeading?: string;
	braceStyle?: BraceStyle;
	/** Text between `{` and `}` for `braceStyle === 'inline'`. */
	braceGap?: string;
	/** Comments and blank lines after the last body node, before the `}`. */
	innerTrivia?: Trivia[];
	/** Indentation of the closing `}` line. */
	closeIndent?: string;
	/** Text after the `}` up to the newline. */
	closeTrailing?: string;
	closeNewline?: string;
	/** True when the source ended before the closing `}`. The printer then writes no `}` either. */
	unclosed?: boolean;
}

export interface NodeBase {
	span?: Span;
	/** Comment and blank lines immediately before this node. */
	trivia: Trivia[];
	layout?: Layout;
}

/** A directive, subdirective, global option or matcher module line: `name [matcher] args... [{ body }]`. */
export interface Directive extends NodeBase {
	kind: 'directive';
	name: Token;
	matcher?: MatcherRef;
	args: Token[];
	body?: Node[];
}

/**
 * A named matcher definition. The block form `@name { ... }` fills `body`.
 * The single-module forms `@name path /foo`, `@name file { try_files ... }`
 * and the CEL shorthand `@name \`cel\`` fill `inline` (a module with a block
 * keeps that block on `inline.body`). For the CEL shorthand the inline
 * directive's `name` is the quoted expression token itself and `args` is
 * empty; see {@link isCelShorthand}.
 */
export interface MatcherDef extends NodeBase {
	kind: 'matcher';
	name: Token;
	body?: Node[];
	inline?: Directive;
}

/**
 * A line the parser could tokenize but not classify: a quoted first token, a
 * stray `}` or `{`, tokens after a closing brace, and so on. Every raw node
 * comes with a diagnostic. Raw nodes round-trip like any other node.
 */
export interface Raw extends NodeBase {
	kind: 'raw';
	tokens: Token[];
	body?: Node[];
}

export type Node = Directive | MatcherDef | Raw;

export interface BlockBase {
	span?: Span;
	trivia: Trivia[];
	layout?: Layout;
}

export interface GlobalBlock extends BlockBase {
	kind: 'global';
	body: Node[];
}

export interface SnippetBlock extends BlockBase {
	kind: 'snippet';
	/** Snippet name without the parentheses. */
	name: string;
	/** The `(name)` token. */
	nameToken?: Token;
	body: Node[];
}

export interface NamedRouteBlock extends BlockBase {
	kind: 'named_route';
	/** Route name without the `&( )`. */
	name: string;
	/** The `&(name)` token. */
	nameToken?: Token;
	body: Node[];
}

export interface SiteBlock extends BlockBase {
	kind: 'site';
	/**
	 * Address tokens. `text` is the address without any trailing comma; `raw`
	 * keeps the comma. A lone `,` token is folded into the next address's
	 * `leading`.
	 */
	addresses: Token[];
	body: Node[];
	/** False for the single-site form without braces. Defaults to true. */
	braces?: boolean;
}

/** A top-level `import` line, outside any block. */
export interface ImportBlock extends BlockBase {
	kind: 'import';
	node: Directive;
}

/** A top-level line that is not a valid block start (for example a stray `}`). Always has a diagnostic. */
export interface RawBlock extends BlockBase {
	kind: 'raw';
	node: Raw;
}

export type Block = GlobalBlock | SnippetBlock | NamedRouteBlock | SiteBlock | ImportBlock | RawBlock;

export interface Caddyfile {
	blocks: Block[];
	/** Comments and blank lines after the last block. */
	trivia: Trivia[];
	/** Dominant line terminator of the file, used for synthesised lines. */
	newline?: string;
	/** Dominant indentation unit of the file, used for synthesised lines. */
	indentUnit?: string;
}

export type Severity = 'error' | 'warning';

export interface Diagnostic {
	severity: Severity;
	message: string;
	span: Span;
}

export interface ParseResult {
	file: Caddyfile;
	diagnostics: Diagnostic[];
}

export interface ParseOptions {
	/**
	 * Directives that accept a leading `[<matcher>]` token, so that a second
	 * token starting with `/` or equal to `*` is classified as a matcher. A
	 * token starting with `@` is always a matcher reference. Defaults to the
	 * standard Caddy directives; W2's schema can pass a complete set.
	 */
	matcherDirectives?: Iterable<string>;
	/**
	 * Directives whose body contains directives (so matcher detection applies
	 * inside). Defaults to `handle`, `route`, `handle_errors`, `handle_path`
	 * and `handle_response`.
	 */
	containerDirectives?: Iterable<string>;
	/**
	 * Directives that take a single positional argument which may start with
	 * `/` without being a matcher (Caddy >= 2.8 `root /srv`). Defaults to `root`.
	 */
	pathArgDirectives?: Iterable<string>;
}
