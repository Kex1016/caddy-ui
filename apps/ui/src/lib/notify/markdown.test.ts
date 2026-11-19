import { describe, expect, it } from 'vitest';
import { inline, parse } from './markdown';

describe('preview markdown', () => {
	it('reads headings, subtext and quotes per line', () => {
		expect(parse('### Down\n-# small\n> quoted\nplain').map((l) => l.k)).toEqual(['h3', 'sub', 'quote', 'p']);
	});

	it('reads bold, italic, underline, strike, code and links, and honours escapes', () => {
		expect(inline('**Error:** x')).toEqual([
			{ k: 'b', c: [{ k: 'text', v: 'Error:' }] },
			{ k: 'text', v: ' x' }
		]);
		expect(inline('\\*.example.com')).toEqual([{ k: 'text', v: '*.example.com' }]);
		expect(inline('a_b\\_c')).toEqual([{ k: 'text', v: 'a_b_c' }]);
		expect(inline('`x*y`')).toEqual([{ k: 'code', v: 'x*y' }]);
		expect(inline('[Open](https://ui.example.com)')).toEqual([
			{ k: 'link', href: 'https://ui.example.com', c: [{ k: 'text', v: 'Open' }] }
		]);
		// A link that is not http(s) stays text.
		expect(inline('[x](javascript:alert(1))')).toEqual([{ k: 'text', v: '[x](javascript:alert(1))' }]);
	});

	it('reads timestamps and mentions', () => {
		expect(inline('<t:1700000000:f>')).toEqual([{ k: 'time', ts: 1_700_000_000_000, style: 'f' }]);
		expect(inline('<@&12> <@34> @here')).toEqual([
			{ k: 'mention', v: '@role' },
			{ k: 'text', v: ' ' },
			{ k: 'mention', v: '@user' },
			{ k: 'text', v: ' ' },
			{ k: 'mention', v: '@here' }
		]);
	});
});
