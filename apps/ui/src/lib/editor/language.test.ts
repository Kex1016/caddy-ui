import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lex } from '@caddy-ui/caddyfile';
import { StringStream, ensureSyntaxTree, foldable, matchBrackets } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { caddyfile, caddyfileParser, type CaddyState } from './language';

const ROOT = join(import.meta.dirname, '../../../../..');
const SAMPLE = readFileSync(join(ROOT, 'packages/caddy-schema/test/fixtures/sample-home.Caddyfile'), 'utf8');

/** Run the stream tokenizer over a text the way CodeMirror does, returning styled segments with offsets. */
function tokenize(text: string): { from: number; to: number; style: string | null }[] {
	const out: { from: number; to: number; style: string | null }[] = [];
	const state: CaddyState = caddyfileParser.startState!(4);
	let offset = 0;
	for (const line of text.split('\n')) {
		const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
		if (clean === '') caddyfileParser.blankLine!(state, 4);
		else {
			const stream = new StringStream(clean, 4, 4);
			while (!stream.eol()) {
				const style = caddyfileParser.token(stream, state);
				if (stream.pos === stream.start)
					throw new Error(`tokenizer stuck at ${offset + stream.pos} in ${JSON.stringify(clean)}`);
				out.push({ from: offset + stream.start, to: offset + stream.pos, style });
				stream.start = stream.pos;
			}
		}
		offset += line.length + 1;
	}
	return out;
}

function styleAt(segs: ReturnType<typeof tokenize>, pos: number) {
	return segs.find((s) => s.from <= pos && pos < s.to);
}

function fixtures(): [string, string][] {
	const out: [string, string][] = [['sample-home', SAMPLE]];
	const dir = join(ROOT, 'packages/caddyfile/fixtures');
	for (const f of readdirSync(dir))
		if (f.endsWith('.caddyfile')) out.push([f, readFileSync(join(dir, f), 'utf8')]);
	const docs = join(dir, 'docs');
	for (const f of readdirSync(docs))
		if (/\.(caddyfile|caddy-d)$/.test(f)) out.push([`docs/${f}`, readFileSync(join(docs, f), 'utf8')]);
	return out;
}

describe('stream tokenizer agrees with the W1 lexer', () => {
	const all = fixtures();
	it('has the fixtures', () => {
		expect(all.length).toBeGreaterThan(500);
	});
	it.each(all)('%s', (_name, text) => {
		const segs = tokenize(text);
		const { lines } = lex(text);
		for (const line of lines) {
			for (const t of line.tokens) {
				const start = t.span!.start;
				const seg = styleAt(segs, start);
				// Every token starts a segment and is never inside a comment.
				expect(seg?.from, `token ${JSON.stringify(t.raw)} at ${start}`).toBe(start);
				expect(seg?.style).not.toBe('comment');
				if (t.quote === 'none' && (t.raw === '{' || t.raw === '}')) expect(seg?.style).toBe('brace');
				if (t.quote === 'double' || t.quote === 'backtick')
					expect(seg?.style).toMatch(/string|placeholder|env/);
				if (t.quote === 'heredoc') expect(seg?.style).toBe('heredocMarker');
			}
			// A trailing `# comment` (and a comment-only line) is a comment segment.
			const hash = line.trailing.indexOf('#');
			if (hash >= 0) {
				const end = line.span.end - line.newline.length;
				const pos = end - (line.trailing.length - hash);
				expect(styleAt(segs, pos)?.style, `comment at ${pos}`).toBe('comment');
			}
		}
	});
});

describe('highlight classes', () => {
	const styleOf = (text: string, needle: string, nth = 0) => {
		let pos = -1;
		for (let i = 0; i <= nth; i++) pos = text.indexOf(needle, pos + 1);
		return styleAt(tokenize(text), pos)?.style;
	};
	const src = [
		'# top comment',
		'{',
		'\temail admin@example.com',
		'}',
		'(tinyauth) {',
		'\tforward_auth 10.0.0.101:8888 {',
		'\t\turi /api/auth/caddy',
		'\t}',
		'}',
		'example.com, www.example.com {',
		'\t@api path /api/*',
		'\timport tinyauth',
		'\treverse_proxy @api 10.0.0.103:8080',
		'\trespond /health "ok {host}" 200',
		'\tredir https://example.org{uri} permanent',
		'\theader X-Env {$APP_ENV}',
		'\texpression `{method} == "GET"`',
		'\trespond <<HTML',
		'\t\t<p>hi # not a comment</p>',
		'\t\tHTML 200',
		'\tfile_server # trailing',
		'}'
	].join('\n');

	it('classifies the Caddyfile constructs PLAN.md §5.1 lists', () => {
		expect(styleOf(src, '# top')).toBe('comment');
		expect(styleOf(src, '# trailing')).toBe('comment');
		expect(styleOf(src, 'example.com,')).toBe('address');
		expect(styleOf(src, 'www.example.com')).toBe('address');
		expect(styleOf(src, '(tinyauth)')).toBe('snippet');
		expect(styleOf(src, 'tinyauth', 1)).toBe('snippet');
		expect(styleOf(src, 'email')).toBe('directive');
		expect(styleOf(src, 'reverse_proxy')).toBe('directive');
		expect(styleOf(src, 'uri /api')).toBe('subdirective');
		expect(styleOf(src, '@api path')).toBe('matcher');
		expect(styleOf(src, '@api 10')).toBe('matcher');
		expect(styleOf(src, '/health')).toBe('matcher');
		expect(styleOf(src, '{host}')).toBe('placeholder');
		expect(styleOf(src, '"ok')).toBe('string');
		expect(styleOf(src, '{uri}')).toBe('placeholder');
		expect(styleOf(src, '{$APP_ENV}')).toBe('env');
		expect(styleOf(src, '`{method}')).toBe('string');
		expect(styleOf(src, '<<HTML')).toBe('heredocMarker');
		expect(styleOf(src, '<p>hi')).toBe('string');
		expect(styleOf(src, 'HTML 200')).toBe('heredocMarker');
		expect(styleOf(src, 'permanent')).toBeNull();
		expect(styleOf(src, '{\n\temail')).toBe('brace');
	});

	it('does not treat # inside a token as a comment', () => {
		expect(styleOf('example.com {\n\trespond a#b\n}', 'a#b')).not.toBe('comment');
	});
});

describe('editor structure', () => {
	const doc = SAMPLE;
	const state = EditorState.create({ doc, extensions: [caddyfile()] });
	ensureSyntaxTree(state, doc.length, 5000);

	it('matches block braces and ignores placeholder braces', () => {
		const open = doc.indexOf('{', doc.indexOf('grimoire.example.com'));
		const m = matchBrackets(state, open, 1);
		expect(m?.matched).toBe(true);
		const close = m!.end!.from;
		// The matched `}` closes the grimoire block: the next non-blank text starts another block.
		expect(doc.slice(open, close)).toContain('handle_errors');
		expect(
			doc
				.slice(close + 1)
				.trimStart()
				.startsWith('}')
		).toBe(false);
		// A placeholder's braces only ever match each other.
		const ph = doc.indexOf('{path}');
		const pm = matchBrackets(state, ph, 1);
		if (pm?.matched) expect(pm.end!.from).toBe(ph + '{path}'.length - 1);
	});

	it('folds every block from its header line', () => {
		const lineNo = doc.slice(0, doc.indexOf('grimoire.example.com')).split('\n').length;
		const line = state.doc.line(lineNo);
		const range = foldable(state, line.from, line.to);
		expect(range).not.toBeNull();
		const folded = doc.slice(range!.from, range!.to);
		expect(folded).toContain('handle_errors');
		expect(doc.slice(range!.to).trimStart().startsWith('}')).toBe(true);
	});

	it('indents by block depth with tabs', async () => {
		const { getIndentation, IndentContext } = await import('@codemirror/language');
		const s = EditorState.create({ doc: 'example.com {\n\thandle {\n\nx\n}', extensions: [caddyfile()] });
		ensureSyntaxTree(s, s.doc.length, 5000);
		const blank = s.doc.line(3).from;
		expect(getIndentation(new IndentContext(s), blank)).toBe(2 * 4);
	});
});
