/**
 * Small Markdown helpers for the Caddy docs. The docs are regular enough that a
 * line-based reader is more predictable than a full Markdown parser: we only need
 * headings, fenced code blocks and top-level bullets.
 */

export type CodeBlock = { lang: string; text: string; line: number };
export type Bullet = { term: string; text: string; line: number };
export type Section = {
	level: number;
	title: string;
	line: number;
	codeBlocks: CodeBlock[];
	bullets: Bullet[];
	/** Prose paragraphs (not bullets, not code), cleaned. */
	paragraphs: string[];
};

/** Strip front matter, <script>/<style> blocks and HTML comments. */
function stripNoise(src: string): string[] {
	const lines = src.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let i = 0;
	if (lines[0] === '---') {
		i = 1;
		while (i < lines.length && lines[i] !== '---') i++;
		i++;
	}
	let skipping: string | null = null;
	for (; i < lines.length; i++) {
		const l = lines[i];
		if (skipping) {
			if (l.includes(`</${skipping}>`)) skipping = null;
			out.push('');
			continue;
		}
		const m = /^\s*<(script|style)\b/.exec(l);
		if (m && !l.includes(`</${m[1]}>`)) {
			skipping = m[1];
			out.push('');
			continue;
		}
		out.push(l);
	}
	return out;
}

export function sections(src: string): Section[] {
	const lines = stripNoise(src);
	const result: Section[] = [];
	let cur: Section = { level: 0, title: '', line: 1, codeBlocks: [], bullets: [], paragraphs: [] };
	result.push(cur);
	let fence: { lang: string; start: number; buf: string[]; indent: string } | null = null;
	let para: string[] = [];
	const flushPara = () => {
		if (para.length) {
			const t = cleanInline(para.join(' '));
			if (t) cur.paragraphs.push(t);
			para = [];
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (fence) {
			const close = /^(\s*)```\s*$/.exec(raw);
			if (close) {
				const text = fence.buf
					.map((l) => (l.startsWith(fence!.indent) ? l.slice(fence!.indent.length) : l))
					.join('\n');
				cur.codeBlocks.push({ lang: fence.lang, text, line: fence.start });
				fence = null;
			} else {
				fence.buf.push(raw);
			}
			continue;
		}
		const open = /^(\s*)```\s*([\w-]*)/.exec(raw);
		if (open) {
			flushPara();
			fence = { lang: open[2], start: i + 1, buf: [], indent: open[1] };
			continue;
		}
		const h = /^(#{1,6})\s+(.*?)\s*$/.exec(raw);
		if (h) {
			flushPara();
			cur = {
				level: h[1].length,
				title: cleanInline(h[2]),
				line: i + 1,
				codeBlocks: [],
				bullets: [],
				paragraphs: []
			};
			result.push(cur);
			continue;
		}
		const b =
			/^- \*\*(.+?)\*\*((?:\s*(?:,|and|or)\s*\*\*.+?\*\*)*)(.*)$/.exec(raw) ??
			/^- `([a-z_][a-z0-9_]*)`(?!\S)()(.*)$/.exec(raw);
		if (b) {
			flushPara();
			const terms = [b[1], ...[...b[2].matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1])];
			for (const t of terms)
				cur.bullets.push({ term: decodeEntities(t).trim(), text: cleanInline(b[3]), line: i + 1 });
			continue;
		}
		if (
			/^\s*$/.test(raw) ||
			/^\s*[-*]\s/.test(raw) ||
			/^\s*</.test(raw) ||
			/^\|/.test(raw) ||
			/^\S.*\|/.test(raw)
		) {
			flushPara();
			continue;
		}
		para.push(raw.trim());
	}
	flushPara();
	return result;
}

export function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

/** Turn a Markdown fragment into plain text suitable for a tooltip. */
export function cleanInline(s: string): string {
	return decodeEntities(
		s
			.replace(/<img[^>]*>/g, '')
			.replace(/<span[^>]*\/>/g, '')
			.replace(/<\/?(a|span|img|i|b|em|strong|code|br|aside|sup|sub|div|p|kbd|small)\b[^>]*>/gi, '')
			.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.replace(/\*\*([^*]+)\*\*/g, '$1')
			.replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)]|$)/g, '$1$2')
	)
		.replace(/\s+/g, ' ')
		.trim();
}

/** First sentence of a paragraph, for summaries. */
export function firstSentence(s: string): string {
	const m = /^(.+?[.!?])(\s|$)/.exec(s);
	return (m ? m[1] : s).trim();
}

/** Strip a bullet's leading "is", "sets", etc. is not done: we keep the docs' wording. Remove a leading "is " only. */
export function bulletDoc(text: string): string {
	return text.replace(/^\s*(is|are)\s+/, '').replace(/^[a-z]/, (c) => c.toUpperCase());
}
