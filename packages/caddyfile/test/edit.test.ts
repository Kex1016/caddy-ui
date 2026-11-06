import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	parse,
	print,
	format,
	createDirective,
	createSite,
	createToken,
	createMatcherDef,
	createCelMatcherDef,
	setArgs,
	setMatcher,
	setTokenText,
	insertNode,
	removeNode,
	replaceNode,
	insertBlock,
	removeBlock,
	nodesFromText,
	relayout,
	commentOutBlock,
	uncommentTrivia,
	sites,
	quoteToken,
	type Directive,
	type SiteBlock
} from '../src/index.js';

const sample = readFileSync(
	new URL('../../caddy-schema/test/fixtures/sample-home.Caddyfile', import.meta.url),
	'utf8'
);

describe('edits re-print only the changed node', () => {
	it('changes one argument and leaves every other byte alone', () => {
		const r = parse(sample);
		const site = sites(r.file).find((s) => s.addresses[0]!.text === 'me.example.com')!;
		const rp = site.body[0] as Directive;
		setArgs(rp, ['10.0.0.103:12345']);
		const out = print(r.file);
		expect(out).toBe(sample.replace('reverse_proxy 10.0.0.103:11081', 'reverse_proxy 10.0.0.103:12345'));
	});

	it('inserts a directive using the indentation of its siblings (8 spaces here, 2 there)', () => {
		const r = parse(sample);
		const eight = sites(r.file).find((s) => s.addresses[0]!.text === 'me.example.com')!;
		insertNode(eight.body, createDirective('encode', ['gzip']));
		const two = sites(r.file).find((s) => s.addresses[0]!.text === 'd.in.example.net')!;
		insertNode(two.body, createDirective('encode', ['zstd', 'gzip'], { matcher: '@x' }), 0);
		const out = print(r.file);
		expect(out).toContain('me.example.com {\n        reverse_proxy 10.0.0.103:11081\n        encode gzip\n}');
		expect(out).toContain('d.in.example.net {\n  encode @x zstd gzip\n  reverse_proxy 10.0.0.101:11003');
	});

	it('inserts a nested block with the detected unit per depth', () => {
		const r = parse('a.com {\n    respond ok\n}\n');
		const site = r.file.blocks[0] as SiteBlock;
		const handle = createDirective('handle', [], {
			matcher: '/api/*',
			body: [
				createDirective('reverse_proxy', ['10.0.0.1:80'], {
					body: [createDirective('header_up', ['Host', '{upstream_hostport}'])]
				})
			]
		});
		insertNode(site.body, handle);
		expect(print(r.file)).toBe(
			'a.com {\n    respond ok\n    handle /api/* {\n        reverse_proxy 10.0.0.1:80 {\n            header_up Host {upstream_hostport}\n        }\n    }\n}\n'
		);
	});

	it('falls back to the file-wide unit for an empty body and to tabs for an empty file', () => {
		const r = parse('a.com {\n\trespond ok\n}\n\nb.com {\n}\n');
		const b = r.file.blocks[1] as SiteBlock;
		insertNode(b.body, createDirective('respond', ['hello world']));
		expect(print(r.file)).toBe('a.com {\n\trespond ok\n}\n\nb.com {\n\trespond "hello world"\n}\n');

		const empty = parse('');
		insertBlock(empty.file, createSite(['c.com'], [createDirective('file_server')]));
		expect(print(empty.file)).toBe('c.com {\n\tfile_server\n}\n');
	});

	it('appends a block after a file without a trailing newline', () => {
		const r = parse('a.com {\n}');
		insertBlock(r.file, createSite(['b.com'], [createDirective('respond', ['b'])], ['added by test']));
		expect(print(r.file)).toBe('a.com {\n}\n\n# added by test\nb.com {\n\trespond b\n}\n');
	});

	it('removes, replaces and moves nodes', () => {
		const r = parse('a.com {\n\t# keep me\n\trespond a\n\tencode gzip\n}\n');
		const site = r.file.blocks[0] as SiteBlock;
		const [respond, encode] = site.body as [Directive, Directive];
		expect(replaceNode(site.body, respond, createDirective('respond', ['b']))).toBe(true);
		expect(print(r.file)).toBe('a.com {\n\t# keep me\n\trespond b\n\tencode gzip\n}\n');
		expect(removeNode(site.body, encode)).toBe(true);
		expect(print(r.file)).toBe('a.com {\n\t# keep me\n\trespond b\n}\n');
		expect(removeBlock(r.file, site)).toBe(true);
		expect(print(r.file)).toBe('');
	});

	it('relayout re-indents a node moved to another depth and keeps its comments', () => {
		const r = parse('a.com {\n\thandle {\n\t\t# why\n\t\trespond ok # trailing\n\t}\n}\n');
		const site = r.file.blocks[0] as SiteBlock;
		const handle = site.body[0] as Directive;
		const respond = handle.body![0]!;
		removeNode(handle.body!, respond);
		insertNode(site.body, relayout(respond), 0);
		expect(print(r.file)).toBe('a.com {\n\t# why\n\trespond ok # trailing\n\thandle {\n\t}\n}\n');
	});

	it('builds nodes from text for recipes and raw rows', () => {
		const r = parse('a.com {\n  respond ok\n}\n');
		const site = r.file.blocks[0] as SiteBlock;
		const nodes = nodesFromText('reverse_proxy 10.0.0.1:80 {\n\theader_up X-Real-IP {remote_host}\n}\n');
		for (const n of nodes) insertNode(site.body, relayout(n));
		expect(print(r.file)).toBe(
			'a.com {\n  respond ok\n  reverse_proxy 10.0.0.1:80 {\n    header_up X-Real-IP {remote_host}\n  }\n}\n'
		);
	});

	it('creates matcher definitions in every form', () => {
		const r = parse('a.com {\n}\n');
		const site = r.file.blocks[0] as SiteBlock;
		insertNode(site.body, createMatcherDef('api', { module: 'path', args: ['/api/*'] }));
		insertNode(
			site.body,
			createMatcherDef('@both', undefined, [
				createDirective('method', ['GET']),
				createDirective('path', ['/x'])
			])
		);
		insertNode(site.body, createCelMatcherDef('cel', '{method} == "GET"'));
		const d = createDirective('respond', ['ok']);
		setMatcher(d, '@api');
		insertNode(site.body, d);
		expect(print(r.file)).toBe(
			'a.com {\n\t@api path /api/*\n\t@both {\n\t\tmethod GET\n\t\tpath /x\n\t}\n\t@cel `{method} == "GET"`\n\trespond @api ok\n}\n'
		);
		expect(parse(print(r.file)).diagnostics).toEqual([]);
	});

	it('quotes token values the way Caddy needs', () => {
		expect(quoteToken('plain')).toBe('plain');
		expect(quoteToken('')).toBe('""');
		expect(quoteToken('has space')).toBe('"has space"');
		expect(quoteToken('{')).toBe('"{"');
		expect(quoteToken('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteToken('ends with \\')).toBe('`ends with \\`');
		expect(quoteToken('a\\"b')).toBe('`a\\"b`');
		expect(quoteToken('two\nlines')).toBe('`two\nlines`');
		expect(quoteToken('`tick` and "quote" and \\"')).toBe('<<EOT\n`tick` and "quote" and \\"\nEOT');
		expect(quoteToken('#hash')).toBe('"#hash"');
		expect(quoteToken('<<EOF')).toBe('"<<EOF"');
		const tok = createToken('x y');
		expect(tok).toMatchObject({ text: 'x y', raw: '"x y"', quote: 'double' });
		setTokenText(tok, 'xy');
		expect(tok).toMatchObject({ text: 'xy', raw: 'xy', quote: 'none' });
	});
});

describe('comment out and restore a block', () => {
	it('round-trips a site through commentOutBlock and uncommentTrivia', () => {
		const r = parse(sample);
		const site = sites(r.file).find((s) => s.addresses[0]!.text === 'prox.example.com')!;
		const original = sample.slice(site.span!.start, site.span!.end);
		const lines = commentOutBlock(r.file, site);
		const out = print(r.file);
		expect(out).not.toContain('\nprox.example.com {');
		expect(out).toContain('#prox.example.com {\n#    reverse_proxy * {');
		expect(parse(out).diagnostics).toEqual([]);
		const restored = uncommentTrivia(lines);
		expect(restored.diagnostics).toEqual([]);
		expect(restored.blocks).toHaveLength(1);
		expect(print({ blocks: restored.blocks, trivia: [] })).toBe(original);
	});

	it('leaves the file otherwise untouched', () => {
		const r = parse('a.com {\n\trespond a\n}\n\nb.com {\n\trespond b\n}\n');
		commentOutBlock(r.file, r.file.blocks[1]!);
		expect(print(r.file)).toBe('a.com {\n\trespond a\n}\n\n#b.com {\n#\trespond b\n#}\n');
		commentOutBlock(r.file, r.file.blocks[0]!);
		expect(print(r.file)).toBe('#a.com {\n#\trespond a\n#}\n\n#b.com {\n#\trespond b\n#}\n');
	});
});

describe('format', () => {
	it('produces caddy fmt style output', () => {
		const src =
			'\n\n  a.com,   b.com   {   # c\n\n\n      respond    "x"   # t\n\n\n      handle   {\n        respond y\n\n      }\n  }\n\n\n# end\n\n';
		expect(format(src)).toBe(
			'a.com, b.com { # c\n\n\trespond "x" # t\n\n\thandle {\n\t\trespond y\n\t}\n}\n\n# end\n'
		);
	});

	it('keeps heredocs and multi-line address lists', () => {
		const src = 'a.com,\nb.com {\n  respond <<EOF\n    hi\n    EOF 200\n}\n';
		expect(format(src)).toBe('a.com,\nb.com {\n\trespond <<EOF\n    hi\n    EOF 200\n}\n');
	});
});
