import { describe, expect, it } from 'vitest';
import { lex, printLexLine } from '../src/lexer.js';

function toks(src: string) {
	const { lines } = lex(src);
	return lines.flatMap((l) => l.tokens.map((t) => [t.text, t.quote] as const));
}

describe('lexer', () => {
	it('splits on whitespace and keeps # inside tokens', () => {
		expect(toks('a b\tc foo#bar')).toEqual([
			['a', 'none'],
			['b', 'none'],
			['c', 'none'],
			['foo#bar', 'none']
		]);
	});

	it('treats # at token start as a comment to end of line', () => {
		const { lines } = lex('a # comment\n# whole line\n   #indented\n');
		expect(lines).toHaveLength(3);
		expect(lines[0]!.tokens.map((t) => t.text)).toEqual(['a']);
		expect(lines[0]!.trailing).toBe(' # comment');
		expect(lines[1]!.tokens).toHaveLength(0);
		expect(lines[1]!.trailing).toBe('# whole line');
		expect(lines[2]!.indent).toBe('   ');
		expect(lines[2]!.trailing).toBe('#indented');
	});

	it('decodes double quotes with \\" escapes and literal backslashes', () => {
		expect(toks('"abc def" "\\"q\\"" "back\\slash" "a\\\\"')).toEqual([
			['abc def', 'double'],
			['"q"', 'double'],
			['back\\slash', 'double'],
			['a\\\\', 'double']
		]);
	});

	it('keeps backticks raw and allows quotes inside', () => {
		expect(toks('`{"foo": "bar"}` `a \\" b`')).toEqual([
			['{"foo": "bar"}', 'backtick'],
			['a \\" b', 'backtick']
		]);
	});

	it('lets quoted tokens span lines', () => {
		const { lines } = lex('respond "first line\n\tsecond line"\nnext\n');
		expect(lines).toHaveLength(2);
		expect(lines[0]!.tokens[1]!.text).toBe('first line\n\tsecond line');
	});

	it('starts a new token right after a closing quote', () => {
		expect(toks('"foo"bar foo"bar"')).toEqual([
			['foo', 'double'],
			['bar', 'none'],
			['foo"bar"', 'none']
		]);
		const { lines } = lex('"foo"#c');
		expect(lines[0]!.tokens.map((t) => t.text)).toEqual(['foo']);
		expect(lines[0]!.trailing).toBe('#c');
	});

	it('reads heredocs, strips the closing marker indentation and keeps trailing args', () => {
		const src = 'respond <<HTML\n\t\t<html>\n\t\t  <body>Foo</body>\n\t\t</html>\n\t\tHTML 200\n';
		const { lines, diagnostics } = lex(src);
		expect(diagnostics).toEqual([]);
		expect(lines).toHaveLength(1);
		const [name, doc, code] = lines[0]!.tokens;
		expect(name!.text).toBe('respond');
		expect(doc!.quote).toBe('heredoc');
		expect(doc!.heredocMarker).toBe('HTML');
		expect(doc!.text).toBe('<html>\n  <body>Foo</body>\n</html>');
		expect(doc!.raw).toBe('<<HTML\n\t\t<html>\n\t\t  <body>Foo</body>\n\t\t</html>\n\t\tHTML');
		expect(code!.text).toBe('200');
		expect(printLexLine(lines[0]!)).toBe(src);
	});

	it('keeps a trailing newline in a heredoc when there is an extra blank line', () => {
		expect(toks('x <<EOF\na\n\nEOF')).toEqual([
			['x', 'none'],
			['a\n', 'heredoc']
		]);
		expect(toks('x <<EOF\nEOF')).toEqual([
			['x', 'none'],
			['', 'heredoc']
		]);
	});

	it('does not treat <<MARKER followed by a space as a heredoc', () => {
		expect(toks('x <<EOF y')).toEqual([
			['x', 'none'],
			['<<EOF', 'none'],
			['y', 'none']
		]);
	});

	it('escapes the heredoc opener with a backslash', () => {
		expect(toks('x \\<<EOF\ny\nEOF')).toEqual([
			['x', 'none'],
			['<<EOF', 'none'],
			['y', 'none'],
			['EOF', 'none']
		]);
	});

	it('reports heredoc problems as diagnostics and keeps lexing', () => {
		expect(lex('x <<\nfoo\n').diagnostics[0]!.message).toMatch(/Missing opening heredoc marker/);
		expect(lex('x <<<EOF\nfoo\nEOF\n').diagnostics[0]!.message).toMatch(/Too many '<'/);
		expect(lex('x <<E O\nfoo\nE O\n').diagnostics).toEqual([]); // just a token
		expect(lex('x <<EOF\nfoo\n').diagnostics[0]!.message).toMatch(/Unterminated heredoc/);
		const mism = lex('x <<EOF\n\tfoo\n  bar\n\tEOF\n');
		expect(mism.diagnostics[0]!.message).toMatch(/Mismatched leading whitespace/);
	});

	it('reports unbalanced quotes', () => {
		expect(lex('respond "oops\n').diagnostics[0]!.message).toBe('Unbalanced double quotes');
		expect(lex('respond `oops\n').diagnostics[0]!.message).toBe('Unbalanced backticks');
	});

	it('joins lines with a backslash continuation', () => {
		const { lines } = lex('a \\\n  b\\\nc\n');
		expect(lines).toHaveLength(1);
		expect(lines[0]!.tokens.map((t) => t.text)).toEqual(['a', 'b', 'c']);
		expect(lines[0]!.tokens[1]!.leading).toBe(' \\\n  ');
		expect(lines[0]!.tokens[2]!.leading).toBe('\\\n');
	});

	it('handles CRLF line endings and a lone CR as whitespace', () => {
		const src = 'a b\r\n\r\nc\r\n';
		const { lines } = lex(src);
		expect(lines.map((l) => l.newline)).toEqual(['\r\n', '\r\n', '\r\n']);
		expect(toks('a\rb')).toEqual([
			['a', 'none'],
			['b', 'none']
		]);
	});

	it('reproduces every line exactly', () => {
		const src = '  a   b  # c\n\n\t"x y"`z`<<E\n 1\n E q  \nno newline at end';
		expect(lex(src).lines.map(printLexLine).join('')).toBe(src);
	});
});
