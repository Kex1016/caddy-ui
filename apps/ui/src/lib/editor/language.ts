/**
 * CodeMirror 6 language for the Caddyfile: an incremental stream tokenizer that follows Caddy's lexer
 * rules (tokens split on whitespace, `#` starts a comment only at the start of a token, `{` and `}` are
 * braces only as whole tokens, double quotes with `\"` escapes, backticks, `<<MARKER` heredocs and `\`
 * line continuations), plus the structural cues the CST uses: the first token of a top-level line is a
 * site address, `(name)` a snippet, `&(name)` a named route; the first token inside a block is a
 * directive or subdirective; `@name` is a matcher; `*` or `/path` right after a directive that accepts a
 * matcher is a matcher token. Placeholders `{…}` and environment variables `{$VAR}` are highlighted
 * inside tokens and double-quoted strings.
 *
 * The tokenizer is checked against W1's lexer on every fixture (see language.test.ts), so token
 * boundaries agree with the parser that validates and saves the file.
 */
import { MATCHER_DIRECTIVES } from '@caddy-ui/caddyfile';
import {
	HighlightStyle,
	StreamLanguage,
	foldService,
	indentUnit,
	matchBrackets,
	syntaxHighlighting,
	type StreamParser,
	type StringStream
} from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { Tag, tags } from '@lezer/highlight';

/** Highlight tags for the Caddyfile constructs that have no good standard tag. */
export const caddyTags = {
	address: Tag.define(tags.heading),
	snippet: Tag.define(tags.macroName),
	directive: Tag.define(tags.keyword),
	subdirective: Tag.define(tags.propertyName),
	matcher: Tag.define(tags.labelName),
	placeholder: Tag.define(tags.variableName),
	env: Tag.define(tags.variableName),
	heredocMarker: Tag.define(tags.processingInstruction)
};

type LineKind = 'none' | 'address' | 'header' | 'directive' | 'matcherdef';

export type CaddyState = {
	/** Open `{` blocks. */
	depth: number;
	/** Inside a multi-line double-quoted or backtick token. */
	quote: '"' | '`' | null;
	/** Inside a heredoc: its marker. */
	heredoc: string | null;
	/** Heredoc opened on this line; its body starts on the next line. */
	heredocPending: string | null;
	/** Tokens seen on the current logical line. */
	tokenIndex: number;
	/** First token of the current logical line. */
	first: string;
	lineKind: LineKind;
	/** In the middle of an unquoted token (after a placeholder or before one). */
	inWord: boolean;
	/** The previous line ended with a `\` continuation, so this line continues it. */
	continued: boolean;
	/** Style of the unquoted word being read. */
	wordStyle: string | null;
};

const PLACEHOLDER_INNER = /^[^\s{}]*\}/;
const NUMBER = /^-?\d+(\.\d+)?(ns|us|µs|ms|s|m|h|d|b|k|kb|kib|m|mb|mib|g|gb|gib|t|tb|tib)?$/i;

function isSpace(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\v' || ch === '\f';
}

/** Read a `{…}` placeholder at the stream position (the `{` is next). Returns the style or null. */
function readPlaceholder(stream: StringStream): string | null {
	const m = stream.match(/^\{\$[A-Za-z0-9_]+(:[^}\s]*)?\}/);
	if (m) return 'env';
	if (stream.match(/^\{[^\s{}]+\}/)) return 'placeholder';
	return null;
}

/** Style of a complete unquoted word, given where it sits. */
function wordStyle(word: string, state: CaddyState): string | null {
	if (state.tokenIndex === 0) {
		if (state.depth === 0) {
			if (word === 'import') return 'directive';
			if (/^&?\(.+\)$/.test(word)) return 'snippet';
			return 'address';
		}
		if (word.startsWith('@')) return 'matcher';
		return state.depth > 1 ? 'subdirective' : 'directive';
	}
	if (state.lineKind === 'address') return 'address';
	if (state.first === 'import' && state.tokenIndex === 1) return 'snippet';
	if (word.startsWith('@')) return 'matcher';
	if (
		state.tokenIndex === 1 &&
		state.lineKind === 'directive' &&
		(word === '*' || word.startsWith('/')) &&
		MATCHER_DIRECTIVES.has(state.first)
	)
		return 'matcher';
	if (NUMBER.test(word)) return 'number';
	return null;
}

function startToken(state: CaddyState, word: string) {
	if (state.tokenIndex === 0) {
		state.first = word;
		if (state.depth === 0 && word !== 'import') {
			state.lineKind = /^&?\(.+\)$/.test(word) ? 'header' : 'address';
		} else {
			state.lineKind = word.startsWith('@') ? 'matcherdef' : 'directive';
		}
	}
}

export const caddyfileParser: StreamParser<CaddyState> = {
	name: 'caddyfile',
	startState: () => ({
		depth: 0,
		quote: null,
		heredoc: null,
		heredocPending: null,
		tokenIndex: 0,
		first: '',
		lineKind: 'none',
		inWord: false,
		continued: false,
		wordStyle: null
	}),
	copyState: (s) => ({ ...s }),

	token(stream, state) {
		if (stream.sol()) {
			if (state.heredocPending) {
				state.heredoc = state.heredocPending;
				state.heredocPending = null;
			}
			if (!state.quote && !state.heredoc) {
				if (!state.continued) {
					state.tokenIndex = 0;
					state.first = '';
					state.lineKind = 'none';
				}
				state.continued = false;
				state.inWord = false;
			}
		}

		// Heredoc body: everything up to a line whose trimmed text is the marker.
		// The closing marker may be followed by more arguments (`HTML 200`).
		if (state.heredoc) {
			const marker = state.heredoc;
			if (stream.sol()) {
				const close = new RegExp(`^\\s*${marker}(?=\\s|$)`);
				if (stream.match(close)) {
					state.heredoc = null;
					state.tokenIndex++;
					return 'heredocMarker';
				}
			}
			stream.skipToEnd();
			return 'string';
		}

		// Continuation of a multi-line quoted token.
		if (state.quote) return readQuotedRest(stream, state);

		if (!state.inWord) {
			if (stream.eatSpace()) return null;
			const ch = stream.peek();
			if (ch === undefined) return null;
			// `\` at the end of the line joins it with the next one.
			if (ch === '\\' && stream.string.slice(stream.pos + 1).trim() === '') {
				stream.skipToEnd();
				state.continued = true;
				return null;
			}
			if (stream.sol() || isSpace(stream.string[stream.pos - 1])) {
				if (ch === '#') {
					stream.skipToEnd();
					return 'comment';
				}
			}
			if (ch === '"' || ch === '`') {
				startToken(state, ch);
				stream.next();
				state.quote = ch;
				return readQuotedRest(stream, state);
			}
			const heredoc = stream.match(/^<<([A-Za-z0-9_-]+)(?=\s|$)/) as RegExpMatchArray | null;
			if (heredoc) {
				startToken(state, '<<');
				state.heredocPending = heredoc[1] ?? null;
				state.tokenIndex++;
				return 'heredocMarker';
			}
			// A whole-token brace.
			const brace = stream.match(/^(\{\}|\{|\})(?=\s|$)/) as RegExpMatchArray | null;
			if (brace) {
				if (brace[1] === '{') state.depth++;
				else if (brace[1] === '}') state.depth = Math.max(0, state.depth - 1);
				if (state.tokenIndex === 0) {
					state.first = brace[1] ?? '';
					state.lineKind = 'none';
				}
				state.tokenIndex++;
				return 'brace';
			}
			// Start of an unquoted word: classify it as a whole.
			const word = /^[^\s]+/.exec(stream.string.slice(stream.pos))?.[0] ?? '';
			startToken(state, word);
			const style = wordStyle(word, state);
			if (style === 'matcher' || style === 'snippet' || (style === 'number' && !word.includes('{'))) {
				stream.pos += word.length;
				state.tokenIndex++;
				return style;
			}
			state.inWord = true;
			state.wordStyle = style;
		}

		// Inside an unquoted word: split out placeholders, keep the word's own style for the rest.
		const ws = state.wordStyle;
		if (stream.peek() === '{') {
			const p = readPlaceholder(stream);
			if (p) {
				endWordIfDone(stream, state);
				return p;
			}
			stream.next();
		}
		while (!stream.eol() && !isSpace(stream.peek()) && stream.peek() !== '{') stream.next();
		endWordIfDone(stream, state);
		return ws;
	},

	blankLine(state) {
		if (state.heredocPending) {
			state.heredoc = state.heredocPending;
			state.heredocPending = null;
		}
		if (!state.quote && !state.heredoc) {
			state.continued = false;
			state.tokenIndex = 0;
			state.first = '';
			state.lineKind = 'none';
		}
	},

	indent(state, textAfter, cx) {
		if (state.quote || state.heredoc) return null;
		const closing = /^\s*\}/.test(textAfter) ? 1 : 0;
		return Math.max(0, state.depth - closing) * cx.unit;
	},

	languageData: {
		commentTokens: { line: '#' },
		closeBrackets: { brackets: ['{', '"', '`'] },
		indentOnInput: /^\s*\}$/
	},

	tokenTable: {
		address: caddyTags.address,
		snippet: caddyTags.snippet,
		directive: caddyTags.directive,
		subdirective: caddyTags.subdirective,
		matcher: caddyTags.matcher,
		placeholder: caddyTags.placeholder,
		env: caddyTags.env,
		heredocMarker: caddyTags.heredocMarker,
		brace: tags.brace,
		string: tags.string,
		comment: tags.lineComment,
		number: tags.number
	}
};

function endWordIfDone(stream: StringStream, state: CaddyState) {
	if (stream.eol() || isSpace(stream.peek())) {
		state.inWord = false;
		state.tokenIndex++;
	}
}

/** Read the rest of a quoted token on this line; placeholders inside double quotes get their own style. */
function readQuotedRest(stream: StringStream, state: CaddyState): string {
	const q = state.quote;
	if (q === '"' && stream.peek() === '{' && PLACEHOLDER_INNER.test(stream.string.slice(stream.pos + 1))) {
		const p = readPlaceholder(stream);
		if (p) return p;
	}
	while (!stream.eol()) {
		const ch = stream.next();
		if (q === '"' && ch === '\\') {
			stream.next();
			continue;
		}
		if (ch === q) {
			state.quote = null;
			// A quoted token may run straight into more token text (`"a"b` is one token in Caddy).
			while (!stream.eol() && !isSpace(stream.peek())) stream.next();
			state.tokenIndex++;
			return 'string';
		}
		if (q === '"' && stream.peek() === '{' && PLACEHOLDER_INNER.test(stream.string.slice(stream.pos + 1)))
			return 'string';
	}
	return 'string';
}

export const caddyfileLanguage = StreamLanguage.define(caddyfileParser);

/**
 * Colours for the tags above. The classes are styled in the editor component with Fishnet tokens, so
 * the theme switch and the caddy theme overrides apply without touching this file.
 */
export const caddyHighlightStyle = HighlightStyle.define([
	{ tag: tags.lineComment, class: 'cf-comment' },
	{ tag: caddyTags.address, class: 'cf-address' },
	{ tag: caddyTags.snippet, class: 'cf-snippet' },
	{ tag: caddyTags.directive, class: 'cf-directive' },
	{ tag: caddyTags.subdirective, class: 'cf-subdirective' },
	{ tag: caddyTags.matcher, class: 'cf-matcher' },
	{ tag: caddyTags.placeholder, class: 'cf-placeholder' },
	{ tag: caddyTags.env, class: 'cf-env' },
	{ tag: caddyTags.heredocMarker, class: 'cf-heredoc' },
	{ tag: tags.string, class: 'cf-string' },
	{ tag: tags.number, class: 'cf-number' },
	{ tag: tags.brace, class: 'cf-brace' }
]);

/** Fold a block from the end of its `{` line to just before its closing `}`. */
export const caddyfileFolding = foldService.of((state: EditorState, lineStart: number, lineEnd: number) => {
	const text = state.doc.sliceString(lineStart, lineEnd);
	// The last `{` that stands as a whole token, ignoring a trailing comment.
	const m = /(?:^|\s)\{(?=\s*(#.*)?$)/.exec(text);
	if (!m) return null;
	const bracePos = lineStart + m.index + m[0].length - 1;
	const match = matchBrackets(state, bracePos, 1);
	if (!match || !match.matched || !match.end) return null;
	const closeLine = state.doc.lineAt(match.end.from);
	if (closeLine.number <= state.doc.lineAt(lineStart).number) return null;
	// Fold up to the end of the line before the `}`, so the closing brace stays visible.
	const to = state.doc.line(closeLine.number - 1).to;
	return to > lineEnd ? { from: lineEnd, to } : null;
});

/**
 * The language with highlighting and folding. New lines are indented with `unit`: pass the file's own
 * indentation (W1 detects it as `indentUnit`); tabs, Caddy's `caddy fmt` style, by default.
 */
export function caddyfile(unit = '\t'): Extension {
	const safe = /^(\t| {1,8})$/.test(unit) ? unit : '\t';
	return [caddyfileLanguage, syntaxHighlighting(caddyHighlightStyle), caddyfileFolding, indentUnit.of(safe)];
}
