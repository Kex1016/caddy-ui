import type { Block, Caddyfile, Layout, Node, Token, Trivia } from './types.js';

export interface PrintOptions {
	/** Line terminator for synthesised lines. Defaults to the file's dominant newline, then `\n`. */
	newline?: string;
	/** Indentation unit for synthesised lines. Defaults to the file's dominant unit, then a tab. */
	indentUnit?: string;
}

interface Ctx {
	newline: string;
	unit: string;
	out: string[];
}

/**
 * Choose the quoting for a token value and return its source form.
 *
 * Caddy's rules: a double-quoted token only escapes `\"`, every other
 * backslash is literal; a backtick token has no escapes at all; a heredoc
 * takes anything. Values that need no quoting are left bare.
 */
export function quoteToken(text: string, heredocMarker = 'EOT'): string {
	if (text === '') return '""';
	const needsQuotes =
		/[\s"`]/.test(text) ||
		text.startsWith('#') ||
		text === '{' ||
		text === '}' ||
		text === '{}' ||
		text.startsWith('<<') ||
		text.startsWith('\\<<');
	if (!needsQuotes) return text;
	const doubleOk = !text.includes('\\"') && !text.endsWith('\\') && !text.includes('\n');
	if (doubleOk) return '"' + text.replace(/"/g, '\\"') + '"';
	if (!text.includes('`')) return '`' + text + '`';
	let marker = heredocMarker;
	while (new RegExp(`(^|\\n)[ \\t]*${marker}(\\s|$)`).test(text)) marker += '_';
	return `<<${marker}\n${text}\n${marker}`;
}

export function tokenRaw(tok: Token): string {
	return tok.raw ?? quoteToken(tok.text);
}

function emit(ctx: Ctx, text: string, newline: string | undefined): void {
	ctx.out.push(text, newline ?? ctx.newline);
}

function tokensSource(tokens: readonly Token[]): string {
	let s = '';
	tokens.forEach((t, i) => {
		// The first token's leading is normally empty (the indent covers it); it is kept only when it
		// carries something that is not plain spacing, such as a lone comma before the first address.
		const lead = i === 0 ? (t.leading && /[^ \t]/.test(t.leading) ? t.leading : '') : (t.leading ?? ' ');
		s += lead + tokenRaw(t);
	});
	return s;
}

function printTrivia(ctx: Ctx, trivia: readonly Trivia[] | undefined, defaultIndent = ''): void {
	if (!trivia) return;
	for (const t of trivia) {
		const indent = t.indent ?? (t.kind === 'comment' ? defaultIndent : '');
		emit(ctx, indent + (t.kind === 'comment' ? t.text : ''), t.newline);
	}
}

/** Indentation step used by the children of a body, detected from the children themselves. */
function unitFor(body: readonly Node[], parentIndent: string, ctx: Ctx): string {
	for (const child of body) {
		const ind = child.layout?.indent;
		if (ind !== undefined && ind.length > parentIndent.length && ind.startsWith(parentIndent)) {
			return ind.slice(parentIndent.length);
		}
	}
	return ctx.unit;
}

/**
 * Print the opening line of a construct plus its body and closing brace.
 * `head` is the text of the opening line up to (not including) the brace.
 */
function printWithBody(
	ctx: Ctx,
	indent: string,
	head: string,
	layout: Layout | undefined,
	body: Node[] | undefined,
	childUnit: string | undefined
): void {
	const trailing = layout?.trailing ?? '';
	if (body === undefined) {
		emit(ctx, indent + head + trailing, layout?.newline);
		return;
	}
	const braceLeading = layout?.braceLeading ?? (head === '' ? '' : ' ');
	let style = layout?.braceStyle ?? 'block';
	if (body.length > 0 && (style === 'empty' || style === 'inline')) style = 'block';
	if (style === 'empty') {
		emit(ctx, indent + head + braceLeading + '{}' + trailing, layout?.newline);
		return;
	}
	if (style === 'inline' && !(layout?.innerTrivia && layout.innerTrivia.length > 0)) {
		emit(
			ctx,
			indent + head + braceLeading + '{' + (layout?.braceGap ?? ' ') + '}' + trailing,
			layout?.newline
		);
		return;
	}
	emit(ctx, indent + head + braceLeading + '{' + trailing, layout?.newline);
	const unit = childUnit ?? unitFor(body, indent, ctx);
	for (const child of body) printNode(ctx, child, indent + unit);
	printTrivia(ctx, layout?.innerTrivia, indent + unit);
	if (layout?.unclosed) return;
	emit(ctx, (layout?.closeIndent ?? indent) + '}' + (layout?.closeTrailing ?? ''), layout?.closeNewline);
}

function printNode(ctx: Ctx, node: Node, defaultIndent: string): void {
	const indent = node.layout?.indent ?? defaultIndent;
	printTrivia(ctx, node.trivia, indent);
	let head: string;
	switch (node.kind) {
		case 'directive': {
			const tokens: Token[] = [node.name];
			if (node.matcher) tokens.push(node.matcher);
			tokens.push(...node.args);
			head = tokensSource(tokens);
			break;
		}
		case 'matcher': {
			const tokens: Token[] = [node.name];
			if (node.inline) tokens.push(node.inline.name, ...node.inline.args);
			head = tokensSource(tokens);
			break;
		}
		case 'raw':
			head = tokensSource(node.tokens);
			break;
	}
	const body = node.kind === 'matcher' ? (node.body ?? node.inline?.body) : node.body;
	printWithBody(ctx, indent, head, node.layout, body, undefined);
}

function printBlock(ctx: Ctx, block: Block): void {
	printTrivia(ctx, block.trivia);
	const indent = block.layout?.indent ?? '';
	switch (block.kind) {
		case 'import':
		case 'raw':
			printNode(ctx, block.node, indent);
			return;
		case 'global':
			printWithBody(ctx, indent, '', block.layout, block.body, undefined);
			return;
		case 'snippet':
			printWithBody(
				ctx,
				indent,
				block.nameToken ? tokensSource([block.nameToken]) : `(${block.name})`,
				block.layout,
				block.body,
				undefined
			);
			return;
		case 'named_route':
			printWithBody(
				ctx,
				indent,
				block.nameToken ? tokensSource([block.nameToken]) : `&(${block.name})`,
				block.layout,
				block.body,
				undefined
			);
			return;
		case 'site': {
			const head = tokensSource(block.addresses);
			if (block.braces === false) {
				const layout = block.layout;
				emit(ctx, indent + head + (layout?.trailing ?? ''), layout?.newline);
				for (const child of block.body) printNode(ctx, child, indent);
				printTrivia(ctx, layout?.innerTrivia, indent);
				return;
			}
			printWithBody(ctx, indent, head, block.layout, block.body, undefined);
			return;
		}
	}
}

/** Print a tree back to text. Unchanged trees print byte-for-byte as parsed. */
export function print(file: Caddyfile, opts: PrintOptions = {}): string {
	const ctx: Ctx = {
		newline: opts.newline ?? file.newline ?? '\n',
		unit: opts.indentUnit ?? file.indentUnit ?? '\t',
		out: []
	};
	for (const block of file.blocks) printBlock(ctx, block);
	printTrivia(ctx, file.trivia);
	return joinLines(ctx);
}

/** Print a list of nodes as they would appear inside a body at `indent`. */
export function printNodes(nodes: readonly Node[], opts: PrintOptions & { indent?: string } = {}): string {
	const ctx: Ctx = { newline: opts.newline ?? '\n', unit: opts.indentUnit ?? '\t', out: [] };
	for (const node of nodes) printNode(ctx, node, opts.indent ?? '');
	return joinLines(ctx);
}

/** Print a single block. */
export function printBlockText(block: Block, opts: PrintOptions = {}): string {
	const ctx: Ctx = { newline: opts.newline ?? '\n', unit: opts.indentUnit ?? '\t', out: [] };
	printBlock(ctx, block);
	return joinLines(ctx);
}

/**
 * Lines are emitted as [text, newline] pairs. A parsed line that was last in
 * its file has an empty newline; if something now follows it, it gets the
 * context newline instead so that nothing is glued together.
 */
function joinLines(ctx: Ctx): string {
	const out = ctx.out;
	let s = '';
	for (let i = 0; i < out.length; i += 2) {
		s += out[i];
		const nl = out[i + 1]!;
		const isLast = i + 2 >= out.length;
		s += nl === '' && !isLast ? ctx.newline : nl;
	}
	return s;
}
