import { describe, expect, it } from 'vitest';
import { installCaddyfileParser } from './caddyfile-parser';
import { getParser, setParser } from './parser';

describe('caddyfile parser seam', () => {
	it('installs a parser that returns a CST, line-numbered diagnostics and formatted text', () => {
		installCaddyfileParser();
		const parser = getParser();
		expect(parser).not.toBeNull();
		const ok = parser!.parse('example.com {\n\trespond ok\n}\n');
		expect(ok.diagnostics).toEqual([]);
		expect((ok.cst as { blocks: unknown[] }).blocks).toHaveLength(1);
		const bad = parser!.parse('example.com {\n\trespond "oops\n');
		expect(bad.diagnostics[0]).toMatchObject({ source: 'parser', severity: 'error', line: 2, column: 10 });
		const schemaWarn = parser!.parse('example.com {\n\tredir https://a.example permanently\n}\n');
		expect(schemaWarn.diagnostics).toEqual([
			expect.objectContaining({ source: 'schema', severity: 'warning', line: 2, directive: 'redir' })
		]);
		expect(parser!.format('a.com   {\n    respond ok\n}')).toBe('a.com {\n\trespond ok\n}\n');
		setParser(null);
	});
});
