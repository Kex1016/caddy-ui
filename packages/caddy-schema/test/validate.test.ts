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

describe('the Porkbun DNS plugin (github.com/caddy-dns/porkbun)', () => {
	const site = (src: string) => validateSiteBody(schema, parseDirectives(src));
	const globals = (src: string) => validateGlobalOptions(schema, parseDirectives(src));
	const BLOCK = '{\n\tapi_key {env.PORKBUN_API_KEY}\n\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}\n}';
	const HOSTS: [string, (src: string) => Diagnostic[], (provider: string) => string][] = [
		['tls { dns }', site, (p) => `tls {\n\tdns ${p}\n}`],
		['tls { issuer acme { dns } }', site, (p) => `tls {\n\tissuer acme {\n\t\tdns ${p}\n\t}\n}`],
		['acme_dns', globals, (p) => `acme_dns ${p}`],
		['dns (global)', globals, (p) => `dns ${p}`]
	];

	it.each(HOSTS)('%s takes the documented block', (_, validate, wrap) => {
		expect(fmt(validate(wrap(`porkbun ${BLOCK}`)))).toBe('');
	});

	it.each(HOSTS)('%s names the plugin module', (name) => {
		const path = {
			'tls { dns }': schema.directives.tls.subdirectives!.dns,
			'tls { issuer acme { dns } }':
				schema.directives.tls.subdirectives!.issuer.variants!.acme.subdirectives!.dns,
			acme_dns: schema.globalOptions.acme_dns,
			'dns (global)': schema.globalOptions.dns
		}[name]!;
		expect(path.variants!.porkbun).toMatchObject({
			plugin: 'dns.providers.porkbun',
			requires: ['api_key', 'api_secret_key'],
			args: []
		});
	});

	it.each(HOSTS)('%s warns about a key written out, without repeating it', (_, validate, wrap) => {
		const diags = validate(
			wrap('porkbun {\n\tapi_key pk1_0123456789abcdef\n\tapi_secret_key "sk1_fedcba9876543210"\n}')
		);
		expect(diags.map((d) => [d.code, d.severity, d.path.at(-1), d.argIndex])).toEqual([
			['literal-secret', 'warning', 'api_key', 0],
			['literal-secret', 'warning', 'api_secret_key', 0]
		]);
		expect(diags[0]!.message).toBe(
			'api_key: this puts the key in the Caddyfile and in History; use {env.PORKBUN_API_KEY} instead'
		);
		expect(JSON.stringify(diags)).not.toMatch(/pk1_0123|sk1_fedc/);
	});

	it('accepts the Caddyfile env form {$NAME} as well as {env.NAME}', () => {
		expect(
			fmt(
				site('tls {\n\tdns porkbun {\n\t\tapi_key {$PORKBUN_API_KEY}\n\t\tapi_secret_key {$SECRET}\n\t}\n}')
			)
		).toBe('');
	});

	it('refuses what the plugin refuses: a missing key, an unknown option, arguments on the line', () => {
		const missing = site('tls {\n\tdns porkbun {\n\t\tapi_key {env.PORKBUN_API_KEY}\n\t}\n}');
		expect(missing).toHaveLength(1);
		expect(missing[0]).toMatchObject({
			code: 'missing-subdirective',
			severity: 'error',
			message: 'dns porkbun needs api_secret_key'
		});
		expect(site('tls {\n\tdns porkbun\n}').map((d) => d.code)).toEqual([
			'missing-subdirective',
			'missing-subdirective'
		]);
		expect(
			site(
				`tls {\n\tdns porkbun {\n\t\tapi_key {env.A}\n\t\tapi_secret_key {env.B}\n\t\tapi_token x\n\t}\n}`
			)[0]
		).toMatchObject({ code: 'unknown-subdirective' });
		expect(site(`tls {\n\tdns porkbun {env.A} ${BLOCK}\n}`)[0]).toMatchObject({ code: 'extra-arg' });
		expect(
			site('tls {\n\tdns porkbun {\n\t\tapi_key a b\n\t\tapi_secret_key {env.B}\n\t}\n}').map((d) => d.code)
		).toContain('extra-arg');
	});

	it('leaves other providers alone, with arguments or with a block of their own', () => {
		expect(fmt(site('tls {\n\tdns cloudflare {env.CF_API_TOKEN}\n}'))).toBe('');
		expect(fmt(site('tls {\n\tdns route53 {\n\t\tregion eu-central-1\n\t\tprofile caddy\n\t}\n}'))).toBe('');
		expect(fmt(globals('acme_dns cloudflare {env.CF_API_TOKEN}'))).toBe('');
		expect(fmt(globals('acme_dns duckdns {\n\tapi_token {env.DUCKDNS_TOKEN}\n}'))).toBe('');
	});
});

describe('values and blocks Caddy accepts that a plain reading of the docs would not', () => {
	const site = (src: string) => validateSiteBody(schema, parseDirectives(src));

	it('takes -1 where Caddy special-cases it', () => {
		for (const sub of ['flush_interval', 'stream_timeout', 'stream_close_delay'])
			expect(fmt(site(`reverse_proxy app:80 {\n\t${sub} -1\n}`)), sub).toBe('');
		expect(fmt(site('php_fastcgi app:9000 {\n\tflush_interval -1\n}'))).toBe('');
		expect(fmt(site('tls {\n\tdns cloudflare {env.CF}\n\tpropagation_timeout -1\n}'))).toBe('');
		expect(fmt(site('tls {\n\tissuer acme {\n\t\tpropagation_timeout -1\n\t}\n}'))).toBe('');
	});

	it('still refuses -1 where Caddy does', () => {
		expect(site('reverse_proxy app:80 {\n\tfail_duration -1\n}').map((d) => d.code)).toEqual(['bad-value']);
		expect(site('tls {\n\tpropagation_delay -1\n}').map((d) => d.code)).toEqual(['bad-value']);
	});

	it('leaves the block of a module the schema does not know (a plugin) alone', () => {
		expect(fmt(site('reverse_proxy app:80 {\n\tlb_policy myplugin {\n\t\tweight 2\n\t}\n}'))).toBe('');
		expect(fmt(site('tls {\n\tissuer myca {\n\t\tendpoint https://ca.example\n\t}\n}'))).toBe('');
		expect(fmt(site('tls {\n\tget_certificate vault {\n\t\taddr https://vault.example\n\t}\n}'))).toBe('');
	});

	it('still checks the block of a module it knows', () => {
		expect(
			site('reverse_proxy app:80 {\n\tlb_policy first {\n\t\tweight 2\n\t}\n}').map((d) => d.code)
		).toEqual(['no-block']);
	});

	it('accepts David’s Porkbun tls block as written (tabs, {env.*})', () => {
		const src =
			'tls {\n\t\tdns porkbun {\n\t\t\tapi_key {env.PORKBUN_API_KEY}\n\t\t\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}\n\t\t}\n\t}';
		expect(fmt(site(src))).toBe('');
	});
});
