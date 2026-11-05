import type { Diagnostic, Quote, Span, Token } from './types.js';

/**
 * One logical line of a Caddyfile: the tokens between two line terminators,
 * where quoted tokens, heredocs and `\`-newline continuations may span several
 * physical lines. Lines without tokens are blank or comment-only lines.
 *
 * `indent + tokens.map(t => t.leading + t.raw).join('') + trailing + newline`
 * reproduces the source text of the line exactly.
 */
export interface LexLine {
	indent: string;
	tokens: Token[];
	/** Whitespace and an optional `# comment` after the last token. */
	trailing: string;
	/** `\n`, `\r\n` or `''` at end of input. */
	newline: string;
	span: Span;
}

export interface LexResult {
	lines: LexLine[];
	diagnostics: Diagnostic[];
}

const HEREDOC_MARKER = /^[A-Za-z0-9_-]+$/;

function isInlineSpace(ch: string): boolean {
	return (
		ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === '\r' || ch === '\u0085' || ch === ' '
	);
}

/** Lex a whole Caddyfile into logical lines. Never throws; problems become diagnostics. */
export function lex(src: string): LexResult {
	const lines: LexLine[] = [];
	const diagnostics: Diagnostic[] = [];
	const n = src.length;
	let pos = 0;

	/** Length of the line terminator at `i`, or 0. */
	const newlineAt = (i: number): number => {
		const ch = src[i];
		if (ch === '\n') return 1;
		if (ch === '\r' && src[i + 1] === '\n') return 2;
		return 0;
	};

	/** Read inline whitespace and `\`-newline continuations starting at `pos`. */
	const readSpace = (): string => {
		const start = pos;
		while (pos < n) {
			const ch = src[pos]!;
			if (isInlineSpace(ch) && newlineAt(pos) === 0) {
				pos++;
				continue;
			}
			if (ch === '\\') {
				const nl = newlineAt(pos + 1);
				if (nl > 0) {
					pos += 1 + nl;
					continue;
				}
			}
			break;
		}
		return src.slice(start, pos);
	};

	const readComment = (): string => {
		const start = pos;
		while (pos < n && newlineAt(pos) === 0) pos++;
		return src.slice(start, pos);
	};

	const readQuoted = (quoteChar: '"' | '`'): Token => {
		const start = pos;
		pos++; // opening quote
		let text = '';
		let closed = false;
		while (pos < n) {
			const ch = src[pos]!;
			if (quoteChar === '"' && ch === '\\') {
				// A backslash escapes the next character: `\"` is a quote, anything else keeps the backslash.
				const next = src[pos + 1];
				if (next === undefined) {
					text += '\\';
					pos++;
					continue;
				}
				text += next === '"' ? '"' : '\\' + next;
				pos += 2;
				continue;
			}
			if (ch === quoteChar) {
				pos++;
				closed = true;
				break;
			}
			text += ch;
			pos++;
		}
		const span = { start, end: pos };
		if (!closed) {
			diagnostics.push({
				severity: 'error',
				message: quoteChar === '"' ? 'Unbalanced double quotes' : 'Unbalanced backticks',
				span
			});
		}
		return { text, raw: src.slice(start, pos), quote: quoteChar === '"' ? 'double' : 'backtick', span };
	};

	/**
	 * Try to read a heredoc starting at `pos` (which points at `<<`). Returns
	 * undefined when this is not a heredoc, in which case `pos` is unchanged.
	 */
	const readHeredoc = (): Token | undefined => {
		const start = pos;
		let i = pos + 2;
		while (i < n && !isInlineSpace(src[i]!) && newlineAt(i) === 0) i++;
		const marker = src.slice(pos + 2, i);
		const nl = newlineAt(i);
		if (nl === 0) {
			// `<<FOO bar` is an ordinary token for Caddy.
			return undefined;
		}
		const markerSpan = { start, end: i };
		if (marker.length === 0) {
			diagnostics.push({
				severity: 'error',
				message:
					'Missing opening heredoc marker; must contain only alpha-numeric characters, dashes and underscores',
				span: markerSpan
			});
			return undefined;
		}
		if (marker.startsWith('<')) {
			diagnostics.push({
				severity: 'error',
				message: "Too many '<' for heredoc; only use two, for example <<END",
				span: markerSpan
			});
			return undefined;
		}
		if (!HEREDOC_MARKER.test(marker)) {
			diagnostics.push({
				severity: 'error',
				message: `Heredoc marker must contain only alpha-numeric characters, dashes and underscores; got '${marker}'`,
				span: markerSpan
			});
			return undefined;
		}
		// Find the closing marker: a line of optional whitespace + marker, followed by whitespace, newline or EOF.
		const contentStart = i + nl;
		let lineStart = contentStart;
		let closeStart = -1;
		let padding = '';
		for (;;) {
			let j = lineStart;
			while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
			if (src.startsWith(marker, j)) {
				const after = j + marker.length;
				if (after >= n || isInlineSpace(src[after]!) || newlineAt(after) > 0) {
					closeStart = lineStart;
					padding = src.slice(lineStart, j);
					pos = after;
					break;
				}
			}
			// advance to next physical line
			let k = lineStart;
			while (k < n && newlineAt(k) === 0) k++;
			if (k >= n) break;
			lineStart = k + newlineAt(k);
		}
		if (closeStart < 0) {
			pos = n;
			const span = { start, end: n };
			diagnostics.push({
				severity: 'error',
				message: `Unterminated heredoc <<${marker}; missing closing marker`,
				span
			});
			return {
				text: src.slice(contentStart),
				raw: src.slice(start, n),
				quote: 'heredoc',
				span,
				heredocMarker: marker
			};
		}
		// Content is everything between the opening line's newline and the closing line start,
		// minus the final newline before the closing marker.
		let content = src.slice(contentStart, closeStart);
		if (content.endsWith('\r\n')) content = content.slice(0, -2);
		else if (content.endsWith('\n')) content = content.slice(0, -1);
		let text: string;
		if (padding === '' || content === '') {
			text = content;
		} else {
			const out: string[] = [];
			const parts = content.split('\n');
			parts.forEach((line, idx) => {
				if (line === '' || line === '\r') {
					out.push('');
					return;
				}
				if (line.startsWith(padding)) {
					out.push(line.slice(padding.length).replace(/\r/g, ''));
				} else {
					diagnostics.push({
						severity: 'error',
						message: `Mismatched leading whitespace in heredoc <<${marker} on content line ${idx + 1}; expected the whitespace before the closing marker`,
						span: { start: contentStart, end: closeStart }
					});
					out.push(line.replace(/\r/g, ''));
				}
			});
			text = out.join('\n');
		}
		return {
			text,
			raw: src.slice(start, pos),
			quote: 'heredoc',
			span: { start, end: pos },
			heredocMarker: marker
		};
	};

	const readPlain = (): Token => {
		const start = pos;
		while (pos < n) {
			const ch = src[pos]!;
			if (isInlineSpace(ch) || newlineAt(pos) > 0) break;
			if (ch === '\\' && newlineAt(pos + 1) > 0) break; // continuation ends the token
			pos++;
		}
		const raw = src.slice(start, pos);
		const text = raw.startsWith('\\<<') ? raw.slice(1) : raw;
		return { text, raw, quote: 'none' as Quote, span: { start, end: pos } };
	};

	while (pos < n || lines.length === 0) {
		const lineStart = pos;
		const indent = readSpace();
		const tokens: Token[] = [];
		let trailing = '';
		let newline = '';
		let leading = '';
		for (;;) {
			if (pos >= n) {
				trailing = leading;
				break;
			}
			const nl = newlineAt(pos);
			if (nl > 0) {
				trailing = leading;
				newline = src.slice(pos, pos + nl);
				pos += nl;
				break;
			}
			const ch = src[pos]!;
			if (ch === '#') {
				trailing = leading + readComment();
				const nl2 = newlineAt(pos);
				newline = src.slice(pos, pos + nl2);
				pos += nl2;
				break;
			}
			let tok: Token | undefined;
			if (ch === '"' || ch === '`') {
				tok = readQuoted(ch);
			} else if (ch === '<' && src[pos + 1] === '<') {
				tok = readHeredoc() ?? readPlain();
			} else {
				tok = readPlain();
			}
			if (tok.raw === '') {
				// Defensive: should not happen, but never loop forever.
				pos++;
				continue;
			}
			tok.leading = leading;
			tokens.push(tok);
			leading = readSpace();
		}
		lines.push({ indent, tokens, trailing, newline, span: { start: lineStart, end: pos } });
		if (pos >= n) break;
	}
	// An input that ends with a newline has an implicit empty last line in
	// editor terms, but we do not need to represent it: the newline belongs to
	// the previous line and nothing follows it.
	return { lines, diagnostics };
}

/** Rebuild the source text of a lexed line. Used by tests. */
export function printLexLine(line: LexLine): string {
	let out = line.indent;
	for (const t of line.tokens) out += (t.leading ?? '') + (t.raw ?? '');
	return out + line.trailing + line.newline;
}
