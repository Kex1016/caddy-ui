/**
 * A deliberately small Caddyfile reader used only by these tests, so the schema can
 * be checked against real files before W1's parser lands. It handles comments,
 * double quotes, backticks, heredocs and nested blocks, and drops everything else
 * (trivia, exact spans) that the round-trip parser in packages/caddyfile owns.
 */
import type { BlockLike, DirectiveLike } from '../src/validate.ts';

type Tok = { text: string; line: number; quoted: boolean };

export function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	let line = 1;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		if (c === '\n') {
			out.push({ text: '\n', line, quoted: false });
			line++;
			i++;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\r') {
			i++;
			continue;
		}
		if (c === '\\' && src[i + 1] === '\n') {
			i += 2;
			line++;
			continue;
		}
		if (c === '#') {
			while (i < n && src[i] !== '\n') i++;
			continue;
		}
		const start = line;
		if (c === '"') {
			let s = '';
			i++;
			while (i < n && src[i] !== '"') {
				if (src[i] === '\\' && (src[i + 1] === '"' || src[i + 1] === '\\')) {
					s += src[i + 1];
					i += 2;
					continue;
				}
				if (src[i] === '\n') line++;
				s += src[i++];
			}
			i++;
			out.push({ text: s, line: start, quoted: true });
			continue;
		}
		if (c === '`') {
			let s = '';
			i++;
			while (i < n && src[i] !== '`') {
				if (src[i] === '\n') line++;
				s += src[i++];
			}
			i++;
			out.push({ text: s, line: start, quoted: true });
			continue;
		}
		const heredoc = /^<<([A-Za-z0-9_-]+)[ \t]*\n/.exec(src.slice(i, i + 64));
		if (heredoc) {
			const marker = heredoc[1];
			i += heredoc[0].length;
			line++;
			const end = new RegExp(`^([ \\t]*)${marker}\\b`, 'm');
			const rest = src.slice(i);
			const m = end.exec(rest);
			const body = m ? rest.slice(0, m.index) : rest;
			line += (body.match(/\n/g) ?? []).length;
			i += m ? m.index + m[0].length : rest.length;
			out.push({ text: body.replace(/\n$/, ''), line: start, quoted: true });
			continue;
		}
		let s = '';
		while (i < n && !/[\s]/.test(src[i])) {
			if (src[i] === '"' && s === '') break;
			s += src[i++];
		}
		out.push({ text: s, line: start, quoted: false });
	}
	return out;
}

type Line = { toks: Tok[]; opens: boolean; closes: boolean };

function lines(toks: Tok[]): Line[] {
	const out: Line[] = [];
	let cur: Tok[] = [];
	const flush = () => {
		if (!cur.length) return;
		const last = cur[cur.length - 1];
		if (cur.length === 1 && last.text === '}' && !last.quoted)
			out.push({ toks: [], opens: false, closes: true });
		else if (last.text === '{' && !last.quoted)
			out.push({ toks: cur.slice(0, -1), opens: true, closes: false });
		else out.push({ toks: cur, opens: false, closes: false });
		cur = [];
	};
	for (const t of toks) {
		if (t.text === '\n') {
			flush();
			continue;
		}
		// `}` can share a line with nothing else; `{ }` on one line opens and closes.
		if (t.text === '}' && !t.quoted && cur.length) {
			if (cur.length === 1 && cur[0].text === '{') {
				cur = [];
				continue;
			}
			flush();
		}
		cur.push(t);
	}
	flush();
	return out;
}

export function parse(src: string): BlockLike[] {
	const ls = lines(tokenize(src));
	let i = 0;
	const body = (): DirectiveLike[] => {
		const nodes: DirectiveLike[] = [];
		while (i < ls.length) {
			const l = ls[i++];
			if (l.closes) return nodes;
			if (!l.toks.length && l.opens) {
				// a bare `{` block (only valid for heredoc-like edge cases); skip its contents
				body();
				continue;
			}
			const [name, ...args] = l.toks;
			const node: DirectiveLike = { name: name.text, args: args.map((a) => a.text), line: name.line };
			if (l.opens) node.body = body();
			nodes.push(node);
		}
		return nodes;
	};
	const blocks: BlockLike[] = [];
	while (i < ls.length) {
		const l = ls[i++];
		if (l.closes) continue;
		if (!l.opens) {
			if (l.toks[0]?.text === 'import') {
				blocks.push({
					kind: 'site',
					body: [{ name: 'import', args: l.toks.slice(1).map((t) => t.text), line: l.toks[0].line }]
				});
				continue;
			}
			// A site without braces: this line is the address, the rest of the file is its body.
			blocks.push({
				kind: 'site',
				name: l.toks.map((t) => t.text).join(' '),
				body: body(),
				line: l.toks[0]?.line
			});
			continue;
		}
		const keys = l.toks.map((t) => t.text);
		const line = l.toks[0]?.line;
		const b = body();
		if (!keys.length) blocks.push({ kind: 'global', body: b, line });
		else if (/^\(.+\)$/.test(keys[0]))
			blocks.push({ kind: 'snippet', name: keys[0].slice(1, -1), body: b, line });
		else if (/^&\(.+\)$/.test(keys[0]))
			blocks.push({ kind: 'named_route', name: keys[0].slice(2, -1), body: b, line });
		else blocks.push({ kind: 'site', name: keys.join(' '), body: b, line });
	}
	return blocks;
}

/** Parse a `caddy-d` snippet (directives without a site block). */
export function parseDirectives(src: string): DirectiveLike[] {
	return parse(`x {\n${src}\n}`)[0]?.body ?? [];
}
