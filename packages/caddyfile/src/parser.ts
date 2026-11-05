import { lex, type LexLine } from './lexer.js';
import { CONTAINER_DIRECTIVES, MATCHER_DIRECTIVES, PATH_ARG_DIRECTIVES } from './directives.js';
import type {
	Block,
	Caddyfile,
	Diagnostic,
	Directive,
	Layout,
	MatcherDef,
	MatcherRef,
	Node,
	ParseOptions,
	ParseResult,
	Raw,
	SiteBlock,
	Span,
	Token,
	Trivia
} from './types.js';

interface BodyContext {
	/** True when the body holds directives, so `/path` and `*` second tokens may be matchers. */
	directives: boolean;
}

interface CloseInfo {
	indent: string;
	trailing: string;
	newline: string;
	span: Span;
}

interface BodyResult {
	body: Node[];
	innerTrivia: Trivia[];
	close?: CloseInfo;
}

function isBare(tok: Token | undefined, raw: string): boolean {
	return tok !== undefined && tok.quote === 'none' && tok.raw === raw;
}

function tokenSource(tok: Token): string {
	return (tok.leading ?? '') + (tok.raw ?? '');
}

class Parser {
	private readonly lines: LexLine[];
	private i = 0;
	readonly diagnostics: Diagnostic[];
	private readonly matcherDirectives: Set<string>;
	private readonly containerDirectives: Set<string>;
	private readonly pathArgDirectives: Set<string>;

	constructor(src: string, opts: ParseOptions) {
		const lexed = lex(src);
		this.lines = lexed.lines;
		this.diagnostics = lexed.diagnostics;
		this.matcherDirectives = new Set(opts.matcherDirectives ?? MATCHER_DIRECTIVES);
		this.containerDirectives = new Set(opts.containerDirectives ?? CONTAINER_DIRECTIVES);
		this.pathArgDirectives = new Set(opts.pathArgDirectives ?? PATH_ARG_DIRECTIVES);
	}

	private error(message: string, span: Span): void {
		this.diagnostics.push({ severity: 'error', message, span });
	}

	private warn(message: string, span: Span): void {
		this.diagnostics.push({ severity: 'warning', message, span });
	}

	private get eof(): boolean {
		return this.i >= this.lines.length;
	}

	private peek(): LexLine {
		return this.lines[this.i]!;
	}

	/** Consume lines without tokens (blank and comment-only lines). */
	private collectTrivia(): Trivia[] {
		const out: Trivia[] = [];
		while (!this.eof) {
			const line = this.peek();
			if (line.tokens.length > 0) break;
			out.push(triviaFromLine(line));
			this.i++;
		}
		return out;
	}

	parseFile(): Caddyfile {
		const blocks: Block[] = [];
		let trailingTrivia: Trivia[] = [];
		let sawGlobal = false;
		while (true) {
			const trivia = this.collectTrivia();
			if (this.eof) {
				trailingTrivia = trivia;
				break;
			}
			const block = this.parseBlock(trivia);
			if (block.kind === 'global') {
				if (sawGlobal) {
					this.error('Duplicate global options block', block.span!);
				} else if (blocks.some((b) => b.kind !== 'import' && b.kind !== 'raw')) {
					this.error('Global options block must be the first block in the Caddyfile', block.span!);
				}
				sawGlobal = true;
			}
			blocks.push(block);
		}
		const file: Caddyfile = { blocks, trivia: trailingTrivia };
		const newline = detectNewline(this.lines);
		if (newline) file.newline = newline;
		const unit = detectIndentUnit(this.lines);
		if (unit) file.indentUnit = unit;
		return file;
	}

	private parseBlock(trivia: Trivia[]): Block {
		const line = this.peek();
		const first = line.tokens[0]!;

		// Global options block: a bare `{` starts the line.
		if (isBare(first, '{')) {
			if (line.tokens.length === 1 || (line.tokens.length === 2 && isBare(line.tokens[1], '}'))) {
				this.i++;
				const layout: Layout = {
					indent: line.indent,
					trailing: line.trailing,
					newline: line.newline,
					braceLeading: ''
				};
				let body: Node[] = [];
				let end = line.span.end;
				if (line.tokens.length === 2) {
					layout.braceStyle = 'inline';
					layout.braceGap = line.tokens[1]!.leading ?? '';
				} else {
					layout.braceStyle = 'block';
					const res = this.parseBody({ directives: false }, first.span!);
					body = res.body;
					end = this.applyClose(layout, res, line, body);
				}
				return { kind: 'global', body, span: { start: line.span.start, end }, trivia, layout };
			}
			this.i++;
			const raw = this.rawNode(line, 'Unexpected tokens after the opening brace of the global options block');
			return { kind: 'raw', node: raw, span: raw.span, trivia };
		}

		if (isBare(first, '{}') && line.tokens.length === 1) {
			this.i++;
			const layout: Layout = {
				indent: line.indent,
				trailing: line.trailing,
				newline: line.newline,
				braceLeading: '',
				braceStyle: 'empty'
			};
			return { kind: 'global', body: [], span: line.span, trivia, layout };
		}

		if (isBare(first, '}')) {
			this.i++;
			const raw = this.rawNode(line, "Unexpected '}' because no matching opening brace");
			return { kind: 'raw', node: raw, span: raw.span, trivia };
		}

		if (first.quote === 'none' && first.text === 'import') {
			this.i++;
			const node = this.parseLine(line, { directives: false });
			if (node.kind === 'directive') {
				return { kind: 'import', node, span: node.span, trivia };
			}
			return { kind: 'raw', node: node as Raw, span: node.span, trivia };
		}

		return this.parseSiteLike(trivia);
	}

	/** Site, snippet or named route: an address list optionally followed by `{`. */
	private parseSiteLike(trivia: Trivia[]): Block {
		const headerLine = this.peek();
		const start = headerLine.span.start;
		this.i++;
		const addresses: Token[] = [];
		let brace: Token | undefined;
		let inlineClose: Token | undefined;
		let line = headerLine;
		let tokens = line.tokens;
		let pendingLeading = '';
		let expectingAnother = false;
		let bad: string | undefined;
		let headerTrailingOverride: string | undefined;
		/** Every header token with merged leading text, for the raw fallback. */
		const headerTokens: Token[] = [];

		for (;;) {
			for (let k = 0; k < tokens.length; k++) {
				const tok = tokens[k]!;
				if (isBare(tok, '{')) {
					if (expectingAnother) {
						bad = "Expected another address but had '{' - check for extra comma";
					}
					brace = { ...tok, leading: pendingLeading + (tok.leading ?? '') };
					pendingLeading = '';
					headerTokens.push(brace);
					const rest = tokens.slice(k + 1);
					if (rest.length === 1 && isBare(rest[0], '}')) {
						inlineClose = rest[0];
						headerTokens.push(rest[0]!);
					} else if (rest.length > 0) {
						// `example.com { respond "hi" }` on one line: Caddy rejects this; keep the line raw.
						headerTokens.push(...rest);
						const raw: Raw = {
							kind: 'raw',
							tokens: headerTokens,
							span: { start, end: line.span.end },
							trivia: [],
							layout: { indent: headerLine.indent, trailing: line.trailing, newline: line.newline }
						};
						this.error("Unexpected tokens after '{' on the same line as the site address", raw.span!);
						return { kind: 'raw', node: raw, span: raw.span, trivia };
					}
					break;
				}
				if (tok.quote === 'none' && tok.text.startsWith('@')) {
					bad = bad ?? 'Request matchers may not be defined globally; put the matcher inside a site block';
				}
				if (tok.quote === 'none' && tok.text.endsWith('{') && tok.text !== '{') {
					bad = bad ?? `Site addresses cannot end with a '{'; put a space before the brace in '${tok.text}'`;
				}
				const leading = pendingLeading + (tok.leading ?? '');
				pendingLeading = '';
				if (tok.quote === 'none' && tok.text === ',') {
					// a lone comma folds into the next address's leading text
					pendingLeading = leading + (tok.raw ?? ',');
					expectingAnother = true;
					continue;
				}
				const addr: Token = { ...tok, leading };
				headerTokens.push(addr);
				if (tok.quote === 'none' && tok.text.endsWith(',')) {
					addr.text = tok.text.slice(0, -1);
					expectingAnother = true;
				} else {
					expectingAnother = false;
				}
				addresses.push(addr);
			}
			if (brace || !expectingAnother) break;
			// The address list continues on the next line with tokens.
			let joined = pendingLeading + line.trailing + line.newline;
			pendingLeading = '';
			let found = false;
			while (!this.eof) {
				const next = this.peek();
				if (next.tokens.length === 0) {
					joined += next.indent + next.trailing + next.newline;
					this.i++;
					continue;
				}
				line = next;
				tokens = next.tokens;
				pendingLeading = joined + next.indent;
				this.i++;
				found = true;
				break;
			}
			if (!found) {
				// EOF while expecting another address; keep the text in the trailing.
				bad = bad ?? 'Expected another address after the trailing comma';
				// push the joined text back as trailing of the last header line
				line = { ...line, trailing: '', newline: '' };
				headerTrailingOverride = joined;
				break;
			}
		}

		const layout: Layout = {
			indent: headerLine.indent,
			trailing: headerTrailingOverride ?? line.trailing,
			newline: headerTrailingOverride !== undefined ? '' : line.newline
		};

		const headerSpan: Span = { start, end: line.span.end };
		if (bad !== undefined) {
			this.error(bad, headerSpan);
		}

		let body: Node[] = [];
		let end = line.span.end;
		let braces = true;
		if (brace) {
			layout.braceLeading = brace.leading ?? '';
			if (inlineClose) {
				layout.braceStyle = 'inline';
				layout.braceGap = inlineClose.leading ?? '';
			} else {
				layout.braceStyle = 'block';
				const res = this.parseBody({ directives: true }, brace.span!);
				body = res.body;
				end = this.applyClose(layout, res, line, body);
			}
		} else {
			braces = false;
			if (addresses.length > 0 && isBare(addresses[addresses.length - 1], '{}')) {
				// `example.com {}` : treat the `{}` as an empty block
				const popped = addresses.pop()!;
				braces = true;
				layout.braceStyle = 'empty';
				layout.braceLeading = popped.leading ?? '';
			} else {
				// Single-site form without braces: everything until EOF (or a stray `}`) belongs to it.
				const res = this.parseBody({ directives: true }, headerSpan, true);
				body = res.body;
				if (res.innerTrivia.length) layout.innerTrivia = res.innerTrivia;
				const last = body[body.length - 1];
				if (last?.span) end = last.span.end;
			}
		}

		const span: Span = { start, end };
		if (addresses.length === 1 && braces) {
			const a = addresses[0]!;
			const t = a.text;
			if (a.quote === 'none' && t.startsWith('&(') && t.endsWith(')') && t.length > 3) {
				return { kind: 'named_route', name: t.slice(2, -1), nameToken: a, body, span, trivia, layout };
			}
			if (a.quote === 'none' && t.startsWith('(') && t.endsWith(')') && t.length > 2) {
				return { kind: 'snippet', name: t.slice(1, -1), nameToken: a, body, span, trivia, layout };
			}
		}
		const site: SiteBlock = { kind: 'site', addresses, body, span, trivia, layout };
		if (!braces) site.braces = false;
		return site;
	}

	/**
	 * Parse body lines until the closing `}` (consumed) or EOF. When
	 * `braceless` is set, a `}` line ends the body without being consumed.
	 */
	parseBody(ctx: BodyContext, openSpan: Span, braceless = false): BodyResult {
		const body: Node[] = [];
		for (;;) {
			const trivia = this.collectTrivia();
			if (this.eof) {
				if (!braceless) this.error("Unclosed block: missing '}' before the end of the file", openSpan);
				return { body, innerTrivia: trivia };
			}
			const line = this.peek();
			if (isBare(line.tokens[0], '}')) {
				if (braceless) return { body, innerTrivia: trivia };
				this.i++;
				let trailing = line.trailing;
				if (line.tokens.length > 1) {
					this.error(
						"Unexpected tokens after '}'; a closing brace must be the only token on its line",
						line.span
					);
					trailing = line.tokens.slice(1).map(tokenSource).join('') + line.trailing;
				}
				return {
					body,
					innerTrivia: trivia,
					close: { indent: line.indent, trailing, newline: line.newline, span: line.span }
				};
			}
			this.i++;
			const node = this.parseLine(line, ctx);
			node.trivia = trivia;
			body.push(node);
		}
	}

	/** Fill the closing-brace part of a layout from a body result and return the end offset. */
	private applyClose(layout: Layout, res: BodyResult, openLine: LexLine, body: Node[]): number {
		if (res.innerTrivia.length) layout.innerTrivia = res.innerTrivia;
		if (res.close) {
			layout.closeIndent = res.close.indent;
			layout.closeTrailing = res.close.trailing;
			layout.closeNewline = res.close.newline;
			return res.close.span.end;
		}
		layout.unclosed = true;
		const lastTrivia = res.innerTrivia[res.innerTrivia.length - 1];
		if (lastTrivia?.span) return lastTrivia.span.end;
		const last = body[body.length - 1];
		if (last?.span) return last.span.end;
		return openLine.span.end;
	}

	/** Consume every remaining line as raw nodes (used by parseFragment after a stray `}`). */
	drainAsRaw(nodes: Node[], pendingTrivia: Trivia[]): Trivia[] {
		let trivia = pendingTrivia;
		while (!this.eof) {
			const line = this.peek();
			this.i++;
			if (line.tokens.length === 0) {
				trivia.push(triviaFromLine(line));
				continue;
			}
			const raw = this.rawNode(line, "Unexpected '}' because no matching opening brace");
			raw.trivia = trivia;
			trivia = [];
			nodes.push(raw);
		}
		return trivia;
	}

	private rawNode(line: LexLine, message: string): Raw {
		this.error(message, line.span);
		const node: Raw = {
			kind: 'raw',
			tokens: line.tokens,
			span: line.span,
			trivia: [],
			layout: { indent: line.indent, trailing: line.trailing, newline: line.newline }
		};
		return node;
	}

	/** Parse one line (plus its block body, if any) into a node. The line is already consumed. */
	private parseLine(line: LexLine, ctx: BodyContext): Node {
		let tokens = line.tokens;
		const layout: Layout = { indent: line.indent, trailing: line.trailing, newline: line.newline };
		let hasBody = false;
		let bodyCtx: BodyContext = { directives: false };
		const last = tokens[tokens.length - 1];
		const beforeLast = tokens[tokens.length - 2];
		let opener: Token | undefined;
		if (tokens.length > 1 && isBare(last, '{')) {
			opener = last;
			layout.braceStyle = 'block';
			tokens = tokens.slice(0, -1);
			hasBody = true;
		} else if (tokens.length > 1 && isBare(last, '{}')) {
			opener = last;
			layout.braceStyle = 'empty';
			tokens = tokens.slice(0, -1);
			hasBody = true;
		} else if (tokens.length > 2 && isBare(last, '}') && isBare(beforeLast, '{')) {
			opener = beforeLast;
			layout.braceStyle = 'inline';
			layout.braceGap = last!.leading ?? '';
			tokens = tokens.slice(0, -2);
			hasBody = true;
		}
		if (opener) layout.braceLeading = opener.leading ?? '';

		const first = tokens[0]!;
		let problem: string | undefined;
		if (first.quote !== 'none') {
			problem = 'A line must start with a directive or matcher name, not a quoted token';
		} else if (first.text === '{' || first.text === '{}' || first.text === '}') {
			if (first.text === '{') {
				problem = "Unexpected '{' on a new line; did you mean to place the '{' on the previous line?";
			} else if (first.text === '{}') {
				problem = "Unexpected '{}' at the start of a line";
			} else {
				problem = "Unexpected '}'";
			}
		} else {
			for (const t of tokens.slice(1)) {
				if (isBare(t, '{')) {
					problem = "Unexpected next token after '{' on same line";
					break;
				}
				if (isBare(t, '}')) {
					problem = "Unexpected '}' because no matching opening brace";
					break;
				}
				if (isBare(t, '{}')) {
					problem = "Unexpected '{}' in the middle of a line";
					break;
				}
			}
		}

		if (problem === undefined && first.quote === 'none' && !first.text.startsWith('@')) {
			const name = first.text;
			if (this.containerDirectives.has(name)) bodyCtx = { directives: true };
		}

		let body: Node[] | undefined;
		let end = line.span.end;
		if (hasBody) {
			if (layout.braceStyle === 'block') {
				const res = this.parseBody(bodyCtx, opener!.span!);
				body = res.body;
				end = this.applyClose(layout, res, line, body);
			} else {
				body = [];
			}
		}

		const span: Span = { start: line.span.start, end };

		if (problem !== undefined) {
			this.error(problem, line.span);
			const raw: Raw = { kind: 'raw', tokens, span, trivia: [], layout };
			if (body) {
				raw.body = body;
			} else {
				delete layout.braceLeading;
				delete layout.braceStyle;
				delete layout.braceGap;
			}
			return raw;
		}

		if (first.text.startsWith('@')) {
			const def: MatcherDef = { kind: 'matcher', name: first, span, trivia: [], layout };
			if (tokens.length >= 2) {
				// `@name path /foo` or `@name file { ... }`: a single matcher module, possibly with a block
				const inline: Directive = {
					kind: 'directive',
					name: tokens[1]!,
					args: tokens.slice(2),
					trivia: [],
					span: { start: tokens[1]!.span!.start, end }
				};
				if (body) inline.body = body;
				def.inline = inline;
			} else if (body) {
				def.body = body;
			} else {
				this.error(`Matcher definition '${first.text}' needs an inline matcher or a block`, line.span);
			}
			return def;
		}

		const name = first;
		const rest = tokens.slice(1);
		let matcher: MatcherRef | undefined;
		const m = rest[0];
		if (m) {
			if (m.text.startsWith('@')) {
				matcher = { ...m, matcherKind: 'named' };
			} else if (ctx.directives && this.matcherDirectives.has(name.text)) {
				const single = rest.length === 1 && this.pathArgDirectives.has(name.text);
				if (m.text === '*') matcher = { ...m, matcherKind: 'all' };
				else if (m.text.startsWith('/') && !single) matcher = { ...m, matcherKind: 'path' };
			}
		}
		const directive: Directive = {
			kind: 'directive',
			name,
			args: matcher ? rest.slice(1) : rest,
			span,
			trivia: [],
			layout
		};
		if (matcher) directive.matcher = matcher;
		if (body) directive.body = body;
		return directive;
	}
}

function triviaFromLine(line: LexLine): Trivia {
	if (line.trailing.startsWith('#')) {
		return {
			kind: 'comment',
			text: line.trailing,
			indent: line.indent,
			newline: line.newline,
			span: line.span
		};
	}
	return {
		kind: 'blank',
		text: '',
		indent: line.indent + line.trailing,
		newline: line.newline,
		span: line.span
	};
}

function detectNewline(lines: LexLine[]): string | undefined {
	let lf = 0;
	let crlf = 0;
	for (const l of lines) {
		if (l.newline === '\n') lf++;
		else if (l.newline === '\r\n') crlf++;
	}
	if (lf === 0 && crlf === 0) return undefined;
	return crlf > lf ? '\r\n' : '\n';
}

/** The most common indentation step between a line and the next more-indented line. */
function detectIndentUnit(lines: LexLine[]): string | undefined {
	const counts = new Map<string, number>();
	let prev = '';
	for (const l of lines) {
		if (l.tokens.length === 0) continue;
		const ind = l.indent;
		if (ind.length > prev.length && ind.startsWith(prev)) {
			const unit = ind.slice(prev.length);
			if (/^[\t ]+$/.test(unit)) counts.set(unit, (counts.get(unit) ?? 0) + 1);
		}
		prev = ind;
	}
	let best: string | undefined;
	let bestCount = 0;
	for (const [unit, c] of counts) {
		if (c > bestCount) {
			best = unit;
			bestCount = c;
		}
	}
	return best;
}

/** Parse a Caddyfile into a lossless concrete syntax tree. Never throws. */
export function parse(src: string, opts: ParseOptions = {}): ParseResult {
	const p = new Parser(src, opts);
	const file = p.parseFile();
	return { file, diagnostics: p.diagnostics };
}

/**
 * Parse text as the body of a block (a list of directives), for example the
 * contents of a raw row in the visual editor or a recipe template. The
 * returned nodes carry their own layout and can be inserted into any body.
 */
export function parseFragment(
	src: string,
	opts: ParseOptions & { directives?: boolean } = {}
): { nodes: Node[]; trailingTrivia: Trivia[]; diagnostics: Diagnostic[] } {
	const p = new Parser(src, opts);
	const res = p.parseBody({ directives: opts.directives ?? true }, { start: 0, end: 0 }, true);
	const nodes = res.body;
	const trailingTrivia = p.drainAsRaw(nodes, res.innerTrivia);
	return { nodes, trailingTrivia, diagnostics: p.diagnostics };
}
