/**
 * Turns Caddyfile text into editor diagnostics with character ranges: W1's parser diagnostics plus W2's
 * schema validation, mapped back from lines and argument indexes to the exact tokens. Client-safe and
 * DOM-free, so the text editor, the server and the tests all use the same code.
 */
import { parse, type Block, type Caddyfile, type Node, type Token } from '@caddy-ui/caddyfile';
import { validateBlocks, type BlockLike, type DirectiveLike } from '@caddy-ui/caddy-schema/validate';
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';

export type EditorSeverity = 'error' | 'warning' | 'info';

/** One problem with a character range in the text. `source` says who found it. */
export type EditorDiagnostic = {
	from: number;
	to: number;
	severity: EditorSeverity;
	source: 'parser' | 'schema' | 'adapt' | 'load' | 'service';
	message: string;
	/** Stable code from the schema validator, when it raised the problem. */
	code?: string;
};

/** Offsets of each line start, for fast line ↔ offset conversion. */
export class LineIndex {
	readonly starts: number[] = [0];
	constructor(readonly text: string) {
		for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
	}
	/** 1-based line of an offset. */
	lineOf(offset: number): number {
		let lo = 0;
		let hi = this.starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((this.starts[mid] as number) <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	}
	/** Range of a 1-based line without its line terminator; clamps out-of-range lines. */
	line(line: number): { from: number; to: number } {
		const i = Math.max(0, Math.min(line - 1, this.starts.length - 1));
		const from = this.starts[i] as number;
		let to = i + 1 < this.starts.length ? (this.starts[i + 1] as number) - 1 : this.text.length;
		if (to > from && this.text.charCodeAt(to - 1) === 13) to--;
		return { from, to };
	}
	/** Offset of a 1-based line and column, clamped to the line. */
	offset(line: number, column = 1): number {
		const r = this.line(line);
		return Math.min(r.to, r.from + Math.max(0, column - 1));
	}
}

/** A schema node together with the tokens its argument indexes refer to. */
type Entry = { name: string; nameToken: Token; argTokens: Token[] };

export type CstMapping = { blocks: BlockLike[]; byLine: Map<number, Entry[]> };

/** Map W1's CST to the validator's node shape, remembering which tokens each line's arguments came from. */
export function cstToBlocks(file: Caddyfile, index: LineIndex): CstMapping {
	const byLine = new Map<number, Entry[]>();
	const remember = (line: number, entry: Entry) => {
		const list = byLine.get(line);
		if (list) list.push(entry);
		else byLine.set(line, [entry]);
	};
	const lineOf = (t: Token) => (t.span ? index.lineOf(t.span.start) : undefined);

	const mapNodes = (nodes: readonly Node[]): DirectiveLike[] => {
		const out: DirectiveLike[] = [];
		for (const node of nodes) {
			if (node.kind === 'raw') continue; // the parser already reported it
			const line = lineOf(node.name);
			if (node.kind === 'directive') {
				const argTokens = node.matcher ? [node.matcher, ...node.args] : node.args;
				const like: DirectiveLike = { name: node.name.text, args: argTokens.map((t) => t.text), line };
				if (node.body) like.body = mapNodes(node.body);
				if (line !== undefined) remember(line, { name: like.name, nameToken: node.name, argTokens });
				out.push(like);
				continue;
			}
			// Named matcher definition.
			const like: DirectiveLike = { name: node.name.text, args: [], line };
			if (node.body) {
				like.body = mapNodes(node.body);
			} else if (node.inline) {
				const inl = node.inline;
				const inlineLine = lineOf(inl.name) ?? line;
				if (inl.body) {
					// `@x file { … }`: the module and its block are one matcher line inside the definition.
					like.body = [
						{
							name: inl.name.text,
							args: inl.args.map((t) => t.text),
							body: mapNodes(inl.body),
							line: inlineLine
						}
					];
				} else {
					like.args = [inl.name.text, ...inl.args.map((t) => t.text)];
				}
				if (inlineLine !== undefined)
					remember(inlineLine, { name: inl.name.text, nameToken: inl.name, argTokens: inl.args });
			}
			if (line !== undefined)
				remember(line, {
					name: like.name,
					nameToken: node.name,
					argTokens: node.inline && !node.inline.body ? [node.inline.name, ...node.inline.args] : []
				});
			out.push(like);
		}
		return out;
	};

	const blocks: BlockLike[] = [];
	for (const b of file.blocks) {
		const like = blockLike(b, mapNodes);
		if (like) {
			like.line = b.span ? index.lineOf(b.span.start) : undefined;
			blocks.push(like);
		}
	}
	return { blocks, byLine };
}

function blockLike(b: Block, mapNodes: (nodes: readonly Node[]) => DirectiveLike[]): BlockLike | null {
	switch (b.kind) {
		case 'global':
			return { kind: 'global', body: mapNodes(b.body) };
		case 'snippet':
			return { kind: 'snippet', name: b.name, body: mapNodes(b.body) };
		case 'named_route':
			return { kind: 'named_route', name: b.name, body: mapNodes(b.body) };
		case 'site':
			return { kind: 'site', body: mapNodes(b.body) };
		default:
			return null;
	}
}

function tokenRange(t: Token | undefined): { from: number; to: number } | null {
	return t?.span ? { from: t.span.start, to: Math.max(t.span.end, t.span.start + 1) } : null;
}

export type Analysis = { file: Caddyfile; diagnostics: EditorDiagnostic[] };

/**
 * Parse and validate. Without a schema only parser diagnostics are returned. Schema problems inside
 * snippets are warnings at most (the validator already treats snippets leniently).
 */
export function analyze(text: string, schema: SchemaBundle | null): Analysis {
	const index = new LineIndex(text);
	const result = parse(text);
	const diagnostics: EditorDiagnostic[] = result.diagnostics.map((d) => {
		let { start: from, end: to } = d.span;
		if (to <= from) {
			// Zero-width spans (end of file, missing brace): underline the rest of the line, or one char back.
			const line = index.line(index.lineOf(from));
			to = Math.max(line.to, from);
			if (to === from && from > 0) from = Math.max(line.from, from - 1);
		}
		return { from, to, severity: d.severity, source: 'parser', message: d.message };
	});
	if (schema) {
		const { blocks, byLine } = cstToBlocks(result.file, index);
		for (const d of validateBlocks(schema, blocks)) {
			const entries = d.line !== undefined ? (byLine.get(d.line) ?? []) : [];
			const last = d.path.at(-1);
			const entry = entries.find((e) => e.name === last) ?? entries[0];
			let range =
				(d.argIndex !== undefined ? tokenRange(entry?.argTokens[d.argIndex]) : null) ??
				tokenRange(entry?.nameToken);
			if (!range) range = d.line !== undefined ? index.line(d.line) : { from: 0, to: 0 };
			diagnostics.push({
				...range,
				severity: d.severity,
				source: 'schema',
				message: d.message,
				code: d.code
			});
		}
	}
	diagnostics.sort((a, b) => a.from - b.from || a.to - b.to);
	return { file: result.file, diagnostics };
}

/**
 * Place diagnostics that only carry a line and column (Caddy's `/adapt` and `/load` errors, from
 * `POST /api/caddyfile/validate` or a refused `PUT`) on the text. Without a line they go on line 1.
 */
export function placeLineDiagnostics(
	text: string,
	diags: readonly {
		severity: EditorSeverity;
		source: EditorDiagnostic['source'];
		message: string;
		line?: number;
		column?: number;
	}[]
): EditorDiagnostic[] {
	const index = new LineIndex(text);
	return diags.map((d) => {
		const line = index.line(d.line ?? 1);
		let from = line.from;
		if (d.column !== undefined && d.column > 1) from = index.offset(d.line ?? 1, d.column);
		// Skip leading indentation so the underline starts at the first token.
		if (d.column === undefined) {
			while (from < line.to && (text[from] === ' ' || text[from] === '\t')) from++;
		}
		return { from, to: Math.max(line.to, from), severity: d.severity, source: d.source, message: d.message };
	});
}

export type OutlineItem = { label: string; kind: Block['kind']; from: number; line: number };

/** Top-level blocks for the "jump to" list: sites by address, global options, snippets, named routes. */
export function outline(file: Caddyfile, text: string): OutlineItem[] {
	const index = new LineIndex(text);
	const out: OutlineItem[] = [];
	for (const b of file.blocks) {
		const from = b.span?.start;
		if (from === undefined) continue;
		let label: string;
		switch (b.kind) {
			case 'global':
				label = 'Global options';
				break;
			case 'site':
				label = b.addresses.map((a) => a.text).join(', ');
				break;
			case 'snippet':
				label = `(${b.name}) snippet`;
				break;
			case 'named_route':
				label = `&(${b.name}) named route`;
				break;
			case 'import':
				label = `import ${b.node.args.map((a) => a.text).join(' ')}`;
				break;
			default:
				continue;
		}
		// The block span may start at its leading comments; point at the header line itself.
		let at = from;
		if (b.kind === 'site' && b.addresses[0]?.span) at = b.addresses[0].span.start;
		else if ((b.kind === 'snippet' || b.kind === 'named_route') && b.nameToken?.span)
			at = b.nameToken.span.start;
		out.push({ label, kind: b.kind, from: at, line: index.lineOf(at) });
	}
	return out;
}
