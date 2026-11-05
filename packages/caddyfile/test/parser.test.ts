import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	parse,
	parseFragment,
	print,
	sites,
	siteId,
	siteKey,
	summarize,
	nodeAt,
	tokenAt,
	findDirectives,
	isCelShorthand,
	type Directive,
	type MatcherDef,
	type SiteBlock
} from '../src/index.js';

const sample = readFileSync(
	new URL('../../caddy-schema/test/fixtures/sample-home.Caddyfile', import.meta.url),
	'utf8'
);

function body(src: string) {
	const r = parse(src);
	expect(r.diagnostics).toEqual([]);
	const b = r.file.blocks[0]!;
	if (!('body' in b)) throw new Error('block has no body');
	return b.body;
}

describe('parser: blocks', () => {
	it('parses the sample Caddyfile into global, snippet and site blocks without diagnostics', () => {
		const r = parse(sample);
		expect(r.diagnostics).toEqual([]);
		const kinds = r.file.blocks.map((b) => b.kind);
		expect(kinds[0]).toBe('global');
		expect(kinds[1]).toBe('snippet');
		expect(kinds.slice(2).every((k) => k === 'site')).toBe(true);
		expect(sites(r.file)).toHaveLength(28);
		expect(r.file.newline).toBe('\n');
	});

	it('reads addresses, commas and the snippet name', () => {
		const r = parse('(tiny) {\n}\n\nexample.com, www.example.com {\n}\nhttp://a , b:8080 {\n}\n');
		expect(r.diagnostics).toEqual([]);
		const [snippet, s1, s2] = r.file.blocks;
		expect(snippet).toMatchObject({ kind: 'snippet', name: 'tiny' });
		expect((s1 as SiteBlock).addresses.map((a) => a.text)).toEqual(['example.com', 'www.example.com']);
		expect((s1 as SiteBlock).addresses[0]!.raw).toBe('example.com,');
		expect((s2 as SiteBlock).addresses.map((a) => a.text)).toEqual(['http://a', 'b:8080']);
		expect((s2 as SiteBlock).addresses[1]!.leading).toBe(' , ');
	});

	it('continues an address list on the next line after a trailing comma', () => {
		const src = 'a.com,\n# between\nb.com, c.com {\n\trespond ok\n}\n';
		const r = parse(src);
		expect(r.diagnostics).toEqual([]);
		const site = r.file.blocks[0] as SiteBlock;
		expect(site.addresses.map((a) => a.text)).toEqual(['a.com', 'b.com', 'c.com']);
		expect(print(r.file)).toBe(src);
	});

	it('parses named routes, top-level import and a braceless single site', () => {
		const r = parse('import sites/*.caddy\n&(api) {\n\trespond api\n}\n');
		expect(r.diagnostics).toEqual([]);
		expect(r.file.blocks[0]).toMatchObject({ kind: 'import' });
		expect(r.file.blocks[1]).toMatchObject({ kind: 'named_route', name: 'api' });

		const b = parse('localhost\nrespond "hi"\nfile_server\n');
		expect(b.diagnostics).toEqual([]);
		const site = b.file.blocks[0] as SiteBlock;
		expect(site.braces).toBe(false);
		expect(site.body.map(summarize)).toEqual(['respond hi', 'file_server']);
		expect(b.file.blocks).toHaveLength(1);
	});

	it('accepts the empty block spellings', () => {
		for (const src of ['{\n}\n', '{ }\n', '{}\n', 'a.com { }\n', 'a.com {}\n', 'a.com {\n}\n']) {
			const r = parse(src);
			expect(r.diagnostics, src).toEqual([]);
			expect(r.file.blocks).toHaveLength(1);
			expect(print(r.file), src).toBe(src);
		}
	});

	it('flags a global options block that is not first, and duplicates', () => {
		const r = parse('a.com {\n}\n{\n\tdebug\n}\n{\n}\n');
		expect(r.diagnostics.map((d) => d.message)).toEqual([
			'Global options block must be the first block in the Caddyfile',
			'Duplicate global options block'
		]);
	});
});

describe('parser: nodes', () => {
	it('detects named, path and wildcard matchers only where Caddy does', () => {
		const nodes = body(
			[
				'a.com {',
				'\t@api path /api/*',
				'\treverse_proxy @api 10.0.0.1:80',
				'\tredir /old /new 301',
				'\trewrite * ?x=1',
				'\troot /srv',
				'\troot /static/* /srv/static',
				'\ttry_files {path} /index.html',
				'\timport /etc/caddy/snippets/*',
				'\tunknown_plugin /path arg',
				'\thandle_path /prefix/* {',
				'\t\treverse_proxy /inner 10.0.0.2:80',
				'\t}',
				'\treverse_proxy 10.0.0.3:80 {',
				'\t\theader_up /notamatcher x',
				'\t\t@accel header X-Accel-Redirect *',
				'\t\thandle_response @accel {',
				'\t\t\tredir /a /b',
				'\t\t}',
				'\t}',
				'}',
				''
			].join('\n')
		) as (Directive | MatcherDef)[];
		const kinds = nodes.map((n) =>
			n.kind === 'directive' ? [n.name.text, n.matcher?.text ?? null] : [n.name.text, 'def']
		);
		expect(kinds).toEqual([
			['@api', 'def'],
			['reverse_proxy', '@api'],
			['redir', '/old'],
			['rewrite', '*'],
			['root', null],
			['root', '/static/*'],
			['try_files', null],
			['import', null],
			['unknown_plugin', null],
			['handle_path', '/prefix/*'],
			['reverse_proxy', null]
		]);
		const handlePath = nodes[9] as Directive;
		expect((handlePath.body![0] as Directive).matcher?.text).toBe('/inner');
		const rp = nodes[10] as Directive;
		const [headerUp, accel, handleResponse] = rp.body as [Directive, MatcherDef, Directive];
		expect(headerUp.matcher).toBeUndefined();
		expect(headerUp.args.map((a) => a.text)).toEqual(['/notamatcher', 'x']);
		expect(accel.inline?.name.text).toBe('header');
		expect(handleResponse.matcher?.matcherKind).toBe('named');
		expect((handleResponse.body![0] as Directive).matcher?.text).toBe('/a');
	});

	it('parses all matcher definition forms', () => {
		const nodes = body(
			[
				'a.com {',
				'\t@a path /x /y',
				'\t@b {',
				'\t\tmethod GET',
				'\t\tnot path /z',
				'\t}',
				'\t@c `{method} == "GET"`',
				'\t@d <<CEL',
				'\t\t{method} == "GET"',
				'\t\tCEL',
				'\t@e file {',
				'\t\ttry_files {path}.html {path}',
				'\t}',
				'\t@f url_pattern /api/:version/* {',
				'\t\tignore_case',
				'\t}',
				'}',
				''
			].join('\n')
		) as MatcherDef[];
		expect(nodes.map((n) => n.kind)).toEqual([
			'matcher',
			'matcher',
			'matcher',
			'matcher',
			'matcher',
			'matcher'
		]);
		expect(nodes[0]!.inline).toMatchObject({ name: { text: 'path' } });
		expect(nodes[0]!.inline!.args.map((a) => a.text)).toEqual(['/x', '/y']);
		expect(nodes[1]!.body!.map(summarize)).toEqual(['method GET', 'not path /z']);
		expect(isCelShorthand(nodes[2]!)).toBe(true);
		expect(nodes[2]!.inline!.name.text).toBe('{method} == "GET"');
		expect(isCelShorthand(nodes[3]!)).toBe(true);
		expect(nodes[3]!.inline!.name.quote).toBe('heredoc');
		expect(nodes[4]!.inline!.name.text).toBe('file');
		expect(nodes[4]!.inline!.body!.map(summarize)).toEqual(['try_files {path}.html {path}']);
		expect(nodes[5]!.inline!.args.map((a) => a.text)).toEqual(['/api/:version/*']);
		expect(nodes[5]!.inline!.body!.map(summarize)).toEqual(['ignore_case']);
	});

	it('keeps comments and blank lines as trivia in the right places', () => {
		const src = '# head\n\na.com { # open\n\t# lead\n\trespond ok # trail\n\n\t# inner\n} # close\n# tail\n';
		const r = parse(src);
		expect(r.diagnostics).toEqual([]);
		const site = r.file.blocks[0] as SiteBlock;
		expect(site.trivia.map((t) => t.kind)).toEqual(['comment', 'blank']);
		expect(site.layout?.trailing).toBe(' # open');
		expect(site.body[0]!.trivia).toMatchObject([{ kind: 'comment', text: '# lead' }]);
		expect(site.body[0]!.layout?.trailing).toBe(' # trail');
		expect(site.layout?.innerTrivia?.map((t) => t.kind)).toEqual(['blank', 'comment']);
		expect(site.layout?.closeTrailing).toBe(' # close');
		expect(r.file.trivia).toMatchObject([{ kind: 'comment', text: '# tail' }]);
		expect(print(r.file)).toBe(src);
	});

	it('treats placeholders that start with { as ordinary tokens', () => {
		const nodes = body('(s) {\n\t{block}\n\t{blocks.foo}\n\trespond {args[0]}\n}\n');
		expect(nodes.map((n) => n.kind)).toEqual(['directive', 'directive', 'directive']);
		expect(nodes.map(summarize)).toEqual(['{block}', '{blocks.foo}', 'respond {args[0]}']);
	});

	it('does not confuse quoted braces with blocks', () => {
		const nodes = body('a.com {\n\trespond "{"\n\trespond `}` "{}"\n}\n');
		expect(nodes.map(summarize)).toEqual(['respond {', 'respond } {}']);
		expect(nodes.every((n) => n.body === undefined)).toBe(true);
	});
});

describe('parser: error recovery', () => {
	const cases: [string, RegExp][] = [
		['a.com {\n\trespond ok\n', /Unclosed block/],
		['a.com {\n}\n}\n', /no matching opening brace/],
		['a.com {\n\t"quoted" first\n}\n', /quoted token/],
		['a.com {\n\thandle { respond ok }\n}\n', /after '\{' on same line/],
		['a.com {\n\thandle\n\t{\n\t}\n}\n', /'\{' on a new line/],
		['a.com { respond ok }\n', /same line as the site address/],
		['@m path /x {\n}\n', /may not be defined globally/],
		['a.com{\n}\n', /cannot end with a '\{'/],
		['a.com, {\n}\n', /extra comma/],
		['a.com {\n\trespond ok\n} trailing\n', /after '\}'/],
		['a.com {\n\t@m\n}\n', /needs an inline matcher or a block/]
	];
	for (const [src, re] of cases) {
		it(`diagnoses ${JSON.stringify(src)}`, () => {
			const r = parse(src);
			expect(r.diagnostics.length).toBeGreaterThan(0);
			expect(
				r.diagnostics.some((d) => re.test(d.message)),
				r.diagnostics.map((d) => d.message).join(' | ')
			).toBe(true);
			expect(print(r.file)).toBe(src);
		});
	}
});

describe('parseFragment', () => {
	it('parses directive lines for recipes and raw rows', () => {
		const r = parseFragment('reverse_proxy /api/* 10.0.0.1:80\n# c\nencode gzip\n');
		expect(r.diagnostics).toEqual([]);
		expect(r.nodes.map(summarize)).toEqual(['reverse_proxy /api/* 10.0.0.1:80', 'encode gzip']);
		expect(r.nodes[1]!.trivia).toMatchObject([{ kind: 'comment', text: '# c' }]);
	});
});

describe('queries', () => {
	const r = parse(sample);

	it('finds nodes and tokens at offsets', () => {
		const idx = sample.indexOf('lb_policy ip_hash');
		const hit = nodeAt(r.file, idx + 3)!;
		expect(summarize(hit.node)).toBe('lb_policy ip_hash');
		expect(hit.ancestors.map((a) => summarize(a))).toEqual(['reverse_proxy *']);
		expect(hit.block.kind).toBe('site');
		expect(tokenAt(r.file, idx + 12)?.text).toBe('ip_hash');
	});

	it('finds directives by name and gives sites a stable identity', () => {
		expect(findDirectives(r.file, 'forward_auth').length).toBe(3);
		const list = sites(r.file);
		const multi = list.find((s) => s.addresses.length === 2)!;
		expect(siteKey(multi)).toBe(
			multi.addresses
				.map((a) => a.text.toLowerCase())
				.sort()
				.join(' ')
		);
		expect(siteId(multi)).toMatch(/^[0-9a-f]{16}$/);
		const ids = new Set(list.map(siteId));
		expect(ids.size).toBe(list.length);
	});
});
