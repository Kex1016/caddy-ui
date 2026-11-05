import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	parse,
	print,
	format,
	quoteToken,
	lex,
	type Caddyfile,
	type Node,
	type Block
} from '../src/index.js';

const RUNS = Number(process.env.FUZZ_RUNS ?? 10_000);

/** Flatten the token values of a tree, in order, ignoring layout. */
function shape(file: Caddyfile): string[] {
	const out: string[] = [];
	const nodes = (list: readonly Node[]): void => {
		for (const n of list) {
			if (n.kind === 'directive') {
				out.push('D', n.name.text);
				if (n.matcher) out.push('M', n.matcher.text);
				for (const a of n.args) out.push('A', a.text);
			} else if (n.kind === 'matcher') {
				out.push('@', n.name.text);
				if (n.inline) {
					out.push('I', n.inline.name.text);
					for (const a of n.inline.args) out.push('A', a.text);
					if (n.inline.body) {
						out.push('{');
						nodes(n.inline.body);
						out.push('}');
					}
				}
			} else {
				out.push('R', ...n.tokens.map((t) => t.text));
			}
			for (const t of n.trivia) if (t.kind === 'comment') out.push('#', t.text.trim());
			if (n.body) {
				out.push('{');
				nodes(n.body);
				out.push('}');
			}
		}
	};
	const block = (b: Block): void => {
		for (const t of b.trivia) if (t.kind === 'comment') out.push('#', t.text.trim());
		out.push('B', b.kind);
		if (b.kind === 'site') out.push(...b.addresses.map((a) => a.text));
		if (b.kind === 'snippet' || b.kind === 'named_route') out.push(b.name);
		if (b.kind === 'import' || b.kind === 'raw') nodes([b.node]);
		else nodes(b.body);
	};
	file.blocks.forEach(block);
	for (const t of file.trivia) if (t.kind === 'comment') out.push('#', t.text.trim());
	return out;
}

// ---- structured Caddyfile generator -------------------------------------------------------------

const word = fc.stringMatching(/^[a-z][a-z0-9_.:-]{0,10}$/);
const path = fc.stringMatching(/^\/[a-z0-9_-]{0,8}(\/\*|\*)?$/);
const placeholder = fc.constantFrom(
	'{path}',
	'{host}',
	'{re.name.1}',
	'{$ENV_VAR}',
	'{$ENV:default}',
	'{args[0]}',
	'{http.request.uri}'
);
const quotedValue = fc.string({ maxLength: 12 }).filter((s) => !s.includes('\n') && !s.includes('\r'));
const dq = quotedValue
	.filter((s) => !s.includes('\\"') && !s.endsWith('\\'))
	.map((s) => '"' + s.replace(/"/g, '\\"') + '"');
const bt = quotedValue.filter((s) => !s.includes('`')).map((s) => '`' + s + '`');
const heredoc = fc
	.tuple(
		fc.constantFrom('EOF', 'HTML', 'CEL_1', 'a-b'),
		fc.array(fc.stringMatching(/^[ a-z<>{}"'#\\]{0,10}$/), { maxLength: 3 })
	)
	.map(([marker, lines]) => `<<${marker}\n${lines.map((l) => '\t\t' + l).join('\n')}\n\t\t${marker}`);
const arg = fc.oneof(
	{ weight: 5, arbitrary: word },
	path,
	placeholder,
	dq,
	bt,
	fc.constant('*'),
	fc.constant('"{"')
);
const sp = fc.constantFrom(' ', '  ', '\t', ' \t ');
const nl = fc.constantFrom('\n', '\n', '\r\n');
const comment = fc.stringMatching(/^#[ a-zA-Z0-9{}"'`\\<]{0,15}$/);
const indentUnit = fc.constantFrom('\t', '  ', '    ', '        ');

interface Gen {
	unit: string;
	nl: string;
}

function lineArb(depth: number, g: Gen): fc.Arbitrary<string> {
	const indent = g.unit.repeat(depth);
	const directiveName = fc.constantFrom(
		'reverse_proxy',
		'respond',
		'redir',
		'header',
		'encode',
		'root',
		'file_server',
		'rewrite',
		'uri',
		'try_files',
		'import',
		'plugin_thing',
		'header_up',
		'tls'
	);
	const simple = fc
		.tuple(
			directiveName,
			fc.array(fc.tuple(sp, arg), { maxLength: 4 }),
			fc.option(fc.tuple(sp, comment), { nil: undefined })
		)
		.map(([name, args, c]) => indent + name + args.map(([s, a]) => s + a).join('') + (c ? c[0] + c[1] : ''));
	const withHeredoc = fc
		.tuple(fc.constantFrom('respond', 'expression'), heredoc, fc.option(word, { nil: undefined }))
		.map(([name, h, after]) => indent + name + ' ' + h + (after ? ' ' + after : ''));
	const matcherInline = fc
		.tuple(
			fc.stringMatching(/^@[a-z][a-z0-9_-]{0,6}$/),
			fc.constantFrom('path', 'header', 'method', 'not path'),
			fc.array(fc.tuple(sp, arg), { minLength: 1, maxLength: 2 })
		)
		.map(([n, m, args]) => indent + n + ' ' + m + args.map(([s, a]) => s + a).join(''));
	const cel = fc.tuple(fc.stringMatching(/^@[a-z]{1,5}$/), bt).map(([n, e]) => indent + n + ' ' + e);
	const commentLine = fc.tuple(fc.constantFrom('', indent, '   '), comment).map(([i, c]) => i + c);
	const blank = fc.constantFrom('', ' ', '\t');
	const continued = fc
		.tuple(directiveName, arg, arg)
		.map(([name, a, b]) => `${indent}${name} ${a} \\${g.nl}${indent}${g.unit}${b}`);
	if (depth >= 4)
		return fc.oneof(
			{ weight: 6, arbitrary: simple },
			withHeredoc,
			matcherInline,
			cel,
			commentLine,
			blank,
			continued
		);
	const block = fc
		.tuple(
			fc.oneof(
				directiveName,
				fc.constantFrom('handle', 'route', 'handle_errors', 'transport http', '@m', 'handle_path /x/*')
			),
			fc.array(fc.tuple(sp, arg), { maxLength: 2 }),
			sp,
			fc.option(fc.tuple(sp, comment), { nil: undefined }),
			fc.array(lineArb(depth + 1, g), { maxLength: 4 }),
			fc.option(fc.tuple(sp, comment), { nil: undefined })
		)
		.map(([name, args, s, c, lines, cc]) =>
			[
				indent + name + args.map(([sp2, a]) => sp2 + a).join('') + s + '{' + (c ? c[0] + c[1] : ''),
				...lines,
				indent + '}' + (cc ? cc[0] + cc[1] : '')
			].join(g.nl)
		);
	const emptyBlock = fc
		.tuple(directiveName, fc.constantFrom(' {}', ' { }', ' {\n' + indent + '}'))
		.map(([n, b]) => indent + n + b.replace(/\n/g, g.nl));
	return fc.oneof(
		{ weight: 6, arbitrary: simple },
		withHeredoc,
		matcherInline,
		cel,
		commentLine,
		blank,
		continued,
		{ weight: 3, arbitrary: block },
		emptyBlock
	);
}

const address = fc.oneof(
	fc.stringMatching(/^[a-z0-9]{1,6}\.(example\.com|localhost)$/),
	fc.stringMatching(/^:[0-9]{2,4}$/),
	fc.constant('http://localhost'),
	fc.constant('*.example.com'),
	fc.constant('https://x.example.com:8443')
);

function blockArb(g: Gen): fc.Arbitrary<string> {
	const header = fc.oneof(
		fc.array(address, { minLength: 1, maxLength: 3 }).map((a) => a.join(', ')),
		fc.tuple(address, address).map(([a, b]) => `${a},${g.nl}${b}`),
		fc.stringMatching(/^\([a-z_]{1,8}\)$/),
		fc.stringMatching(/^&\([a-z_]{1,8}\)$/)
	);
	return fc
		.tuple(
			header,
			sp,
			fc.option(fc.tuple(sp, comment), { nil: undefined }),
			fc.array(lineArb(1, g), { maxLength: 6 })
		)
		.map(([h, s, c, lines]) => [h + s + '{' + (c ? c[0] + c[1] : ''), ...lines, '}'].join(g.nl));
}

const caddyfileArb: fc.Arbitrary<string> = fc.tuple(indentUnit, nl).chain(([unit, newline]) => {
	const g: Gen = { unit, nl: newline };
	const global = fc
		.array(
			fc.oneof(lineArb(1, g), fc.constantFrom(unit + 'debug', unit + 'admin off', unit + 'email a@b.c')),
			{ maxLength: 4 }
		)
		.map((lines) => ['{', ...lines, '}'].join(newline));
	return fc
		.tuple(
			fc.option(global, { nil: undefined }),
			fc.array(fc.oneof(blockArb(g), fc.constant('import conf.d/*'), comment, fc.constant('')), {
				maxLength: 6
			}),
			fc.constantFrom('', newline, newline + newline, newline + '# end')
		)
		.map(([gl, blocks, tail]) => [...(gl ? [gl] : []), ...blocks].join(newline + newline) + tail);
});

// ---- properties -----------------------------------------------------------------------------

describe('fuzz', () => {
	it(`print(parse(x)) === x for ${RUNS} arbitrary strings`, () => {
		fc.assert(
			fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (s) => {
				expect(print(parse(s).file)).toBe(s);
			}),
			{ numRuns: RUNS }
		);
	});

	it('print(parse(x)) === x for strings made of Caddyfile ingredients', () => {
		const pieces = fc.constantFrom(
			'{',
			'}',
			'{}',
			' ',
			'\t',
			'\n',
			'\r\n',
			'#',
			'"',
			'`',
			'\\',
			'<<',
			'EOF',
			'a',
			',',
			'@m',
			'/p',
			'*',
			'(s)',
			'&(r)',
			'import',
			'\\"'
		);
		fc.assert(
			fc.property(
				fc.array(pieces, { maxLength: 30 }).map((p) => p.join('')),
				(s) => {
					expect(print(parse(s).file)).toBe(s);
				}
			),
			{ numRuns: RUNS }
		);
	});

	it(`generated Caddyfiles round-trip, parse clean, and survive format()`, () => {
		fc.assert(
			fc.property(caddyfileArb, (src) => {
				const r = parse(src);
				expect(print(r.file)).toBe(src);
				expect(r.diagnostics).toEqual([]);
				const once = format(src);
				const again = format(once);
				expect(again).toBe(once);
				expect(shape(parse(once).file)).toEqual(shape(r.file));
			}),
			{ numRuns: Math.max(100, Math.floor(RUNS / 50)) }
		);
	});

	it('quoteToken produces a token that lexes back to the same value', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 20 }), (s) => {
				const raw = quoteToken(s);
				const { lines, diagnostics } = lex('x ' + raw + ' y\n');
				expect(diagnostics).toEqual([]);
				const tokens = lines.flatMap((l) => l.tokens);
				expect(tokens.map((t) => t.text)).toEqual(['x', s, 'y']);
			}),
			{ numRuns: RUNS }
		);
	});

	it('lexer never throws and always reproduces its input', () => {
		fc.assert(
			fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), (s) => {
				const { lines } = lex(s);
				const back = lines
					.map(
						(l) => l.indent + l.tokens.map((t) => (t.leading ?? '') + t.raw).join('') + l.trailing + l.newline
					)
					.join('');
				expect(back).toBe(s);
			}),
			{ numRuns: RUNS }
		);
	});
});
