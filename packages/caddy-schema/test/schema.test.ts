import { describe, expect, it } from 'vitest';
import {
	ARG_TYPES,
	checkValue,
	defaultOrder,
	effectiveOrder,
	resolvePath,
	schema,
	searchPlaceholders,
	type ArgSchema,
	type DirectiveSchema
} from '../src/index.ts';

function* walk(node: DirectiveSchema, path: string[]): Generator<[string[], DirectiveSchema]> {
	yield [path, node];
	for (const [k, v] of Object.entries(node.subdirectives ?? {})) yield* walk(v, [...path, k]);
	for (const [k, v] of Object.entries(node.variants ?? {})) yield* walk(v, [...path, `~${k}`]);
}

const allNodes = () => [
	...Object.values(schema.directives).flatMap((d) => [...walk(d, [d.name])]),
	...Object.values(schema.globalOptions).flatMap((d) => [...walk(d, ['(global)', d.name])])
];

describe('schema shape', () => {
	it('has the 41 standard directives', () => {
		expect(Object.keys(schema.directives)).toHaveLength(41);
	});

	it('every node follows the contract', () => {
		for (const [path, n] of allNodes()) {
			const where = path.join('/');
			expect(typeof n.name, where).toBe('string');
			expect(typeof n.summary, where).toBe('string');
			expect(n.docsUrl, where).toMatch(/^https:\/\/caddyserver\.com\/docs\//);
			expect(typeof n.order, where).toBe('number');
			expect(typeof n.matcher, where).toBe('boolean');
			expect(Array.isArray(n.examples), where).toBe(true);
			for (const a of [...n.args, ...(n.forms ?? []).flat(), ...(n.rows ?? []).flat()]) checkArg(a, where);
		}
	});

	it('every directive has a summary, docs link and at least one example', () => {
		for (const d of Object.values(schema.directives)) {
			expect(d.summary, d.name).not.toBe('');
			expect(d.docsUrl).toBe(`https://caddyserver.com/docs/caddyfile/directives/${d.name}`);
			expect(d.examples.length, d.name).toBeGreaterThan(0);
		}
	});

	it('orders directives as Caddy does', () => {
		for (const d of Object.values(schema.directives)) {
			if (d.order === -1) expect(defaultOrder, d.name).not.toContain(d.name);
			else expect(defaultOrder[d.order], d.name).toBe(d.name);
		}
		expect(
			Object.values(schema.directives)
				.filter((d) => d.order === -1)
				.map((d) => d.name)
				.sort()
		).toEqual(['bind', 'handle_errors', 'import', 'log', 'tls']);
		for (const name of defaultOrder)
			expect(
				schema.directives[name] ?? resolvePath(['reverse_proxy', 'handle_response', name]),
				name
			).toBeDefined();
		expect(defaultOrder.indexOf('redir')).toBeLessThan(defaultOrder.indexOf('rewrite'));
		expect(defaultOrder.indexOf('reverse_proxy')).toBeLessThan(defaultOrder.indexOf('file_server'));
	});

	it('marks the grouping directives as taking directives', () => {
		for (const n of ['handle', 'handle_path', 'handle_errors', 'route'])
			expect(schema.directives[n].allowsDirectives, n).toBe(true);
		expect(resolvePath(['reverse_proxy', 'handle_response'])?.allowsDirectives).toBe(true);
	});

	it('covers what the plan calls out for reverse_proxy', () => {
		const rp = schema.directives.reverse_proxy;
		for (const s of [
			'to',
			'dynamic',
			'lb_policy',
			'health_uri',
			'health_interval',
			'fail_duration',
			'header_up',
			'header_down',
			'transport',
			'handle_response',
			'replace_status'
		])
			expect(rp.subdirectives?.[s], s).toBeDefined();
		expect(Object.keys(rp.subdirectives!.transport.variants!).sort()).toEqual(['fastcgi', 'http']);
		expect(Object.keys(rp.subdirectives!.dynamic.variants!).sort()).toEqual(['a', 'multi', 'srv']);
		expect(Object.keys(rp.subdirectives!.lb_policy.variants!)).toContain('ip_hash');
		expect(resolvePath(['reverse_proxy', 'transport', 'http', 'tls_insecure_skip_verify'])).toBeDefined();
		expect(resolvePath(['reverse_proxy', 'transport', 'http', 'tls_server_name'])?.args[0].type).toBe(
			'string'
		);
		expect(rp.subdirectives!.header_up.args[0]).toMatchObject({ type: 'header', prefixes: ['+', '-'] });
	});

	it('gives php_fastcgi every reverse_proxy subdirective', () => {
		const php = schema.directives.php_fastcgi.subdirectives!;
		for (const s of Object.keys(schema.directives.reverse_proxy.subdirectives!))
			expect(php[s], s).toBeDefined();
		expect(php.split).toBeDefined();
	});

	it('has the 17 standard request matchers with CEL forms', () => {
		expect(Object.keys(schema.matchers).sort()).toEqual(
			[
				'client_ip',
				'expression',
				'file',
				'header',
				'header_regexp',
				'host',
				'method',
				'not',
				'path',
				'path_regexp',
				'protocol',
				'query',
				'remote_ip',
				'tls',
				'url_pattern',
				'vars',
				'vars_regexp'
			].sort()
		);
		for (const m of Object.values(schema.matchers)) {
			expect(m.celForm, m.name).not.toBe('');
			expect(m.args.length, m.name).toBeGreaterThan(0);
			expect(m.docsUrl).toMatch(/^https:\/\/caddyserver\.com\/docs\/caddyfile\/matchers#/);
		}
		expect(schema.matcherTokenForms.map((f) => f.name)).toEqual(['wildcard', 'path', 'named']);
		expect(Object.keys(schema.responseMatchers).sort()).toEqual(['header', 'status']);
	});

	it('has the global options David uses with bespoke-friendly detail', () => {
		expect(schema.globalOptions.email.args[0]).toMatchObject({ name: 'email' });
		expect(schema.globalOptions.admin.args[0]).toMatchObject({ literals: ['off'] });
		expect(resolvePath(['servers', 'trusted_proxies', 'static'], schema.globalOptions)).toBeDefined();
		expect(resolvePath(['metrics', 'per_host'], schema.globalOptions)).toBeDefined();
		for (const o of Object.values(schema.globalOptions)) {
			expect(o.category, o.name).toBe('global');
			expect(o.summary, o.name).not.toBe('');
		}
	});

	it('has a placeholder catalogue with shorthands linked to long forms', () => {
		const names = schema.placeholders.map((p) => p.name);
		expect(new Set(names).size).toBe(names.length);
		for (const p of [
			'{host}',
			'{uri}',
			'{path}',
			'{path.N}',
			'{re.name.N}',
			'{http.request.header.*}',
			'{env.*}',
			'{upstream_hostport}',
			'{err.status_code}',
			'{args[N]}'
		])
			expect(names, p).toContain(p);
		const host = schema.placeholders.find((p) => p.name === '{host}')!;
		expect(host.longForm).toBe('{http.request.host}');
		for (const p of schema.placeholders) expect(p.doc, p.name).not.toBe('');
		expect(searchPlaceholders('http.request.tls').every((p) => p.scope === 'tls')).toBe(true);
	});

	it('records the docs commit it came from', () => {
		expect(schema.source.repo).toBe('caddyserver/website');
		expect(schema.source.commit).toMatch(/^[0-9a-f]{40}$/);
	});
});

function checkArg(a: ArgSchema, where: string) {
	expect(ARG_TYPES, `${where} ${a.name}`).toContain(a.type);
	expect(a.name, where).toMatch(/^[a-z0-9_]+$/);
	expect(typeof a.doc, `${where} ${a.name}`).toBe('string');
	if (a.type === 'enum') expect(a.enum?.length, `${where} ${a.name}`).toBeGreaterThan(0);
}

describe('value grammars', () => {
	it.each([
		['duration', '30s', true],
		['duration', '1h30m', true],
		['duration', '2d', true],
		['duration', '-1', false],
		['duration', 'soon', false],
		['size', '4KiB', true],
		['size', '10MB', true],
		['size', 'lots', false],
		['status', '308', true],
		['status', '5xx', true],
		['status', '99', false],
		['int', '42', true],
		['int', '4.2', false],
		['header', 'X-Forwarded-For', true],
		['header', 'Bad Header', false],
		['upstream', '10.0.0.103:3000', true],
		['upstream', 'http://app/path', false],
		['placeholder', '{my_var}', true],
		['matcher', '@name', true],
		['matcher', 'name', false],
		['duration', '{env.TIMEOUT}', true]
	] as const)('%s %s → %s', (type, value, ok) => {
		expect(checkValue(type, value) === null).toBe(ok);
	});

	it('accepts literals and prefixes', () => {
		expect(checkValue('duration', 'off', { literals: ['off'] })).toBeNull();
		expect(checkValue('header', '-Server', { prefixes: ['+', '-'] })).toBeNull();
	});
});

describe('effectiveOrder', () => {
	it('applies order options', () => {
		const o = effectiveOrder([
			['rate_limit', 'before', 'basic_auth'],
			['respond', 'first']
		]);
		expect(o[0]).toBe('respond');
		expect(o.indexOf('rate_limit')).toBe(o.indexOf('basic_auth') - 1);
	});
});
