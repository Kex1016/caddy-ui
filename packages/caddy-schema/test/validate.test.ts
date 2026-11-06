import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	schema,
	validateBlocks,
	validateSiteBody,
	validateGlobalOptions,
	type Diagnostic
} from '../src/index.ts';
import { parse, parseDirectives } from './mini-parse.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const fmt = (ds: Diagnostic[]) =>
	ds.map((d) => `${d.severity} L${d.line} ${d.path.join(' > ')}: ${d.message}`).join('\n');

describe('the sample home-lab Caddyfile (David’s file with addresses anonymised)', () => {
	const blocks = parse(fixture('sample-home.Caddyfile'));

	it('parses into the expected blocks', () => {
		expect(blocks.filter((b) => b.kind === 'global')).toHaveLength(1);
		expect(blocks.filter((b) => b.kind === 'snippet').map((b) => b.name)).toEqual(['tinyauth_forwarder']);
		expect(blocks.filter((b) => b.kind === 'site')).toHaveLength(28);
	});

	it('validates clean: no errors and no warnings', () => {
		const diags = validateBlocks(schema, blocks);
		expect(fmt(diags)).toBe('');
	});

	it('every directive it uses is in the schema', () => {
		const used = new Set<string>();
		const walk = (nodes: { name: string; body?: typeof nodes }[]) => {
			for (const n of nodes) {
				if (!n.name.startsWith('@')) used.add(n.name);
				if (n.body && schema.directives[n.name]?.allowsDirectives) walk(n.body);
			}
		};
		for (const b of blocks) if (b.kind !== 'global') walk(b.body);
		for (const name of used) expect(schema.directives[name], name).toBeDefined();
		expect([...used].sort()).toEqual(
			[
				'file_server',
				'forward_auth',
				'handle',
				'handle_errors',
				'redir',
				'reverse_proxy',
				'rewrite',
				'route',
				'try_files',
				'uri'
			].sort()
		);
	});
});

describe('diagnostics', () => {
	const site = (src: string) => validateSiteBody(schema, parseDirectives(src));

	it('flags a bad duration with the argument index', () => {
		const [d] = site('reverse_proxy localhost:8080 {\n\thealth_interval ten\n}');
		expect(d).toMatchObject({
			code: 'bad-value',
			severity: 'error',
			path: ['reverse_proxy', 'health_interval'],
			argIndex: 0
		});
		expect(d.message).toMatch(/duration/);
	});

	it('flags an unknown subdirective', () => {
		const [d] = site('reverse_proxy localhost:8080 {\n\thealth_url /\n}');
		expect(d).toMatchObject({ code: 'unknown-subdirective', path: ['reverse_proxy', 'health_url'] });
	});

	it('flags an upstream with a path', () => {
		const [d] = site('reverse_proxy https://example.com/api');
		expect(d.code).toBe('bad-value');
		expect(d.message).toMatch(/cannot contain a path/);
	});

	it('accepts every upstream form', () => {
		for (const u of [
			'localhost:8080',
			':8080',
			'10.0.0.1:80',
			'[::1]:8080',
			'https://example.com',
			'h2c://127.0.0.1:9000',
			'unix//run/app.sock',
			'localhost:8001-8006',
			'{env.BACKEND}'
		])
			expect(fmt(site(`reverse_proxy ${u}`)), u).toBe('');
	});

	it('flags missing and extra arguments', () => {
		expect(site('root')[0]).toMatchObject({ code: 'missing-arg' });
		expect(site('redir /a /b 301 extra')[0]).toMatchObject({ code: 'extra-arg', argIndex: 3 });
	});

	it('knows the matcher token is not an argument', () => {
		expect(fmt(site('redir /old /new permanent'))).toBe('');
		expect(fmt(site('rewrite * /index.html'))).toBe('');
	});

	it('flags a named matcher that is not defined', () => {
		expect(site('respond @missing 404')[0]).toMatchObject({ code: 'undefined-matcher', argIndex: 0 });
		expect(fmt(site('@api path /api/*\nrespond @api 404'))).toBe('');
	});

	it('sees named matchers defined inside handle blocks', () => {
		expect(fmt(site('handle /x/* {\n\t@a path /x/a\n\trespond @a 200\n}'))).toBe('');
	});

	it('validates matcher definitions', () => {
		expect(site('@m path_regexp ^/(+$')[0]).toMatchObject({ code: 'bad-regexp', severity: 'warning' });
		expect(site('@m method')[0]).toMatchObject({ code: 'missing-arg' });
		expect(
			fmt(site('@m {\n\tpath /a*\n\tnot remote_ip private_ranges\n\theader X-A *\n}\nrespond @m 403'))
		).toBe('');
		expect(fmt(site('@m `path("/a*") && {method} == "GET"`\nrespond @m 403'))).toBe('');
	});

	it('only warns on unknown directives (they may be plugins)', () => {
		const [d] = site('rate_limit 10r/s');
		expect(d).toMatchObject({ code: 'unknown-directive', severity: 'warning' });
	});

	it('enters module variants', () => {
		expect(
			fmt(
				site(
					'reverse_proxy app:80 {\n\ttransport http {\n\t\ttls_server_name app.internal\n\t\tversions 1.1 2\n\t}\n}'
				)
			)
		).toBe('');
		const [d] = site('reverse_proxy app:80 {\n\ttransport http {\n\t\troot /srv\n\t}\n}');
		expect(d).toMatchObject({ code: 'unknown-subdirective', path: ['reverse_proxy', 'transport', 'root'] });
		expect(fmt(site('reverse_proxy app:80 {\n\ttransport fastcgi {\n\t\troot /srv\n\t}\n}'))).toBe('');
		expect(fmt(site('reverse_proxy a:1 b:2 {\n\tlb_policy cookie lb secret\n}'))).toBe('');
	});

	it('checks uri operations', () => {
		expect(fmt(site('uri strip_prefix /api'))).toBe('');
		expect(fmt(site('uri replace /a /b 1'))).toBe('');
		expect(site('uri replace /a')[0]).toMatchObject({ code: 'missing-arg' });
		expect(site('uri strip_prefix /a /b')[0]).toMatchObject({ code: 'extra-arg' });
	});

	it('checks tls argument forms', () => {
		for (const t of ['tls internal', 'tls me@example.com', 'tls cert.pem key.pem', 'tls'])
			expect(fmt(site(t)), t).toBe('');
	});

	it('keeps copy_response inside handle_response', () => {
		expect(site('copy_response')[0]).toMatchObject({ code: 'not-allowed-here' });
		expect(
			fmt(
				site(
					'reverse_proxy a:1 {\n\t@err status 5xx\n\thandle_response @err {\n\t\tcopy_response 503\n\t}\n}'
				)
			)
		).toBe('');
	});

	it('flags a block on a directive that takes none', () => {
		expect(site('redir /a /b {\n\tfoo\n}')[0]).toMatchObject({ code: 'no-block' });
	});

	it('validates global options', () => {
		const g = (src: string) => validateGlobalOptions(schema, parseDirectives(src));
		expect(
			fmt(
				g(
					'email me@example.com\nadmin off\nmetrics {\n\tper_host\n}\nservers {\n\ttrusted_proxies static private_ranges\n}'
				)
			)
		).toBe('');
		expect(g('grace_period soon')[0]).toMatchObject({ code: 'bad-value' });
		expect(g('auto_https sometimes')[0]).toMatchObject({ code: 'bad-value' });
		expect(g('acme_dnss cloudflare')[0]).toMatchObject({
			code: 'unknown-global-option',
			severity: 'warning'
		});
	});
});
