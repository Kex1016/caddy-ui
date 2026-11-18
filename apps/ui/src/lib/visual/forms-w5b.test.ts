/**
 * W5b: the bespoke forms for the 29 directives and 13 matcher modules W5a left to the schema.
 * Every form round-trips each example from the Caddy docs (read every field, write it back, the text
 * is unchanged) and has at least one edit that prints the expected text.
 */
import { describe, expect, it } from 'vitest';
import {
	parse,
	print,
	type Directive,
	type MatcherDef,
	type Node,
	type SiteBlock
} from '@caddy-ui/caddyfile';
import { schema } from '@caddy-ui/caddy-schema';
import { formForDirective, formForMatcher, unclaimedLines, type FieldSpec, type FormSpec } from './forms';
import { chooseOther, otherProviderFields } from './forms/directives/dns-provider';
import { findField, roundTrip } from './testing';

const W5A = [
	'reverse_proxy',
	'forward_auth',
	'handle',
	'route',
	'handle_errors',
	'handle_path',
	'redir',
	'rewrite',
	'uri',
	'try_files',
	'file_server',
	'import'
];
const W5B = Object.keys(schema.directives).filter((d) => !W5A.includes(d));
const W5B_MATCHERS = Object.keys(schema.matchers).filter(
	(m) => !['path', 'path_regexp', 'expression', 'not'].includes(m)
);

/** Every directive named `name` in non-global blocks, at any depth. */
function directivesNamed(nodes: readonly Node[], name: string, out: Directive[] = []): Directive[] {
	for (const n of nodes) {
		if (n.kind !== 'directive') continue;
		if (n.name.text === name) out.push(n);
		if (n.body) directivesNamed(n.body, name, out);
	}
	return out;
}

/** Every request matcher definition in the file, at any depth. */
function matcherDefs(nodes: readonly Node[], out: MatcherDef[] = []): MatcherDef[] {
	for (const n of nodes) {
		if (n.kind === 'matcher') out.push(n);
		else if (n.kind === 'directive' && n.body) matcherDefs(n.body, out);
	}
	return out;
}

/** Indent a bare snippet of directives into a site block. */
const wrap = (raw: string) => `a.com {\n${raw.replace(/^(?=.)/gm, '\t')}\n}\n`;

function inBlocks(r: ReturnType<typeof parse>, name: string): Directive[] {
	const found: Directive[] = [];
	for (const b of r.file.blocks)
		if (b.kind === 'site' || b.kind === 'snippet' || b.kind === 'named_route')
			directivesNamed(b.body, name, found);
	return found;
}

const bodies = (text: string) =>
	parse(text).file.blocks.flatMap((b) =>
		b.kind === 'site' || b.kind === 'snippet' || b.kind === 'named_route' ? [b.body] : []
	);

/** Parse a site with one body line (tabs) and return the file and its first directive. */
function one(line: string) {
	const r = parse(`a.com {\n${line}\n}\n`);
	const node = (r.file.blocks[0] as SiteBlock).body.find((n): n is Directive => n.kind === 'directive')!;
	return { r, node, out: () => print(r.file) };
}

const spec = (name: string): FormSpec => formForDirective(schema, name).spec;
const mspec = (name: string): FormSpec => formForMatcher(schema, name).spec;
const f = <K extends FieldSpec['kind']>(s: FormSpec, id: string, kind?: K) => findField(s.fields, id, kind);

describe('W5b coverage', () => {
	it('has bespoke forms for all 41 directives and every matcher module', () => {
		expect(Object.keys(schema.directives)).toHaveLength(41);
		expect(W5B).toHaveLength(29);
		for (const d of Object.keys(schema.directives))
			expect(formForDirective(schema, d).source, d).toBe('bespoke');
		for (const m of Object.keys(schema.matchers)) expect(formForMatcher(schema, m).source, m).toBe('bespoke');
		expect(W5B_MATCHERS).toHaveLength(13);
	});

	it('round-trips every docs example of the 29 directives', () => {
		let count = 0;
		const perName = new Map<string, number>();
		const unclaimed = new Set<string>();
		for (const name of W5B) {
			const examples = schema.directives[name]!.examples;
			expect(examples.length, name).toBeGreaterThan(0);
			for (const raw of examples) {
				// bare directive examples (`header -Hidden`) get a site to live in
				let ex = raw;
				let r = parse(ex);
				let found = inBlocks(r, name);
				if (!found.length && inBlocks(parse(wrap(raw)), name).length) {
					ex = wrap(raw);
					r = parse(ex);
					found = inBlocks(r, name);
				}
				perName.set(name, (perName.get(name) ?? 0) + found.length);
				for (const n of found) {
					const s = spec(name);
					roundTrip(s, n);
					for (const u of unclaimedLines(s, n))
						if (u.kind === 'directive') unclaimed.add(`${name} > ${u.name.text}`);
					count++;
				}
				expect(print(r.file), `${name}: ${ex}`).toBe(ex);
			}
		}
		for (const name of W5B) expect(perName.get(name), name).toBeGreaterThan(0);
		expect(count).toBeGreaterThanOrEqual(80);
		// Lines the forms leave to the tree and the text view on purpose: handle_response children of
		// intercept and template plugin extensions. Free-form rows (header, map, vars, basic_auth, push)
		// claim every line.
		for (const u of unclaimed)
			expect(['intercept > handle_response', 'templates > extensions'], u).toContain(u);
	});

	it('round-trips every docs example of the 13 matcher modules', () => {
		let count = 0;
		for (const name of W5B_MATCHERS) {
			for (const raw of schema.matchers[name]!.examples ?? []) {
				// one-line examples are bare matcher definitions; give them a site to live in
				const ex = raw.startsWith('@') || raw.startsWith('vars ') ? `a.com {\n${raw}\n}\n` : raw;
				const r = parse(ex);
				for (const body of r.file.blocks.flatMap((b) => (b.kind === 'site' ? [b.body] : []))) {
					for (const def of matcherDefs(body)) {
						const mods = def.inline ? [def.inline] : (def.body ?? []);
						for (const m of mods) {
							if (m.kind !== 'directive') continue;
							roundTrip(mspec(m.name.text), m);
							if (m.name.text === name) count++;
						}
					}
				}
				expect(print(r.file), `${name}: ${raw}`).toBe(ex);
			}
		}
		expect(count).toBeGreaterThanOrEqual(20);
	});

	it('the docs examples do not fall back to "other lines" for subdirectives the forms model', () => {
		const ex = bodies(schema.directives.log!.examples[2]!)[0]!;
		const log = directivesNamed(ex, 'log')[0]!;
		expect(unclaimedLines(spec('log'), log)).toEqual([]);
	});
});

describe('W5b directive edits', () => {
	it('log: output file, rotation, format, level, sampling', () => {
		const { node, out } = one('\tlog');
		const s = spec('log');
		const output = f(s, 'output', 'variant');
		const file = output.set(node, 'file')!;
		f(s, 'filename', 'text').set(file, '/var/log/caddy/access.log');
		f(s, 'roll_keep', 'text').set(file, '5');
		f(s, 'level', 'select').set(node, 'ERROR');
		const format = f(s, 'format', 'variant');
		const filter = format.set(node, 'filter')!;
		f(s, 'filters', 'rows').set(filter, [['request>headers>Cookie', 'delete']]);
		expect(out()).toBe(
			'a.com {\n\tlog {\n\t\toutput file /var/log/caddy/access.log {\n\t\t\troll_keep 5\n\t\t}\n\t\tlevel ERROR\n\t\tformat filter {\n\t\t\trequest>headers>Cookie delete\n\t\t}\n\t}\n}\n'
		);
		expect(s.describe!(node)).toBe('→ file /var/log/caddy/access.log');
		const sampling = f(s, 'sampling', 'group');
		const g = sampling.create(node);
		f(s, 'thereafter', 'text').set(g, '10');
		expect(out()).toContain('\t\tsampling {\n\t\t\tthereafter 10\n\t\t}\n');
	});

	it('log: filter rows keep a wrap line and blocks on rows', () => {
		const ex = schema.directives.log!.examples[7]!; // format append { server_id …; wrap filter { … } }
		const r = parse(ex);
		const log = directivesNamed((r.file.blocks[0] as SiteBlock).body, 'log')[0]!;
		const s = spec('log');
		const fmt = f(s, 'format', 'variant').get(log)!;
		expect(fmt.value).toBe('append');
		const rows = f(s, 'appended', 'rows');
		expect(rows.get(fmt.node)).toEqual([['server_id', '{env.SERVER_ID}']]);
		rows.set(fmt.node, [
			['server_id', '{env.SERVER_ID}'],
			['region', 'eu']
		]);
		expect(print(r.file)).toBe(
			ex.replace('server_id {env.SERVER_ID}\n', 'server_id {env.SERVER_ID}\n\t\t\tregion eu\n')
		);
	});

	it('log_append, log_level, log_name, log_skip', () => {
		const a = one('\tlog_append <original_path {http.request.uri.path}');
		const s = spec('log_append');
		expect(f(s, 'key', 'text').get(a.node)).toBe('original_path');
		expect(f(s, 'early', 'toggle').get(a.node)).toBe(true);
		f(s, 'early', 'toggle').set(a.node, false);
		f(s, 'key', 'text').set(a.node, 'path');
		expect(a.out()).toBe('a.com {\n\tlog_append path {http.request.uri.path}\n}\n');

		const l = one('\tlog_level /healthz DEBUG');
		f(spec('log_level'), 'arg0', 'select').set(l.node, 'WARN');
		expect(l.out()).toBe('a.com {\n\tlog_level /healthz WARN\n}\n');

		const n = one('\tlog_name health_check_log');
		f(spec('log_name'), 'args0', 'list').set(n.node, ['health_check_log', 'audit']);
		expect(n.out()).toBe('a.com {\n\tlog_name health_check_log audit\n}\n');

		expect(spec('log_skip').fields.map((x) => x.kind)).toEqual(['note']);
	});

	it('header: one-line form, rows with comments, defer and match', () => {
		const ex = schema.directives.header!.examples[3]!; // header { # comments … }
		const w = parse(wrap(ex));
		const header = (w.file.blocks[0] as SiteBlock).body[0] as Directive;
		const s = spec('header');
		const ops = f(s, 'operations', 'rows');
		expect(ops.get(header)).toEqual([
			['Strict-Transport-Security', 'max-age=31536000;'],
			['X-Content-Type-Options', 'nosniff'],
			['X-Frame-Options', 'DENY']
		]);
		ops.set(header, [
			['Strict-Transport-Security', 'max-age=31536000;'],
			['X-Content-Type-Options', 'nosniff'],
			['X-Frame-Options', 'SAMEORIGIN'],
			['-Server']
		]);
		f(s, 'defer', 'toggle').set(header, true);
		const text = print(w.file);
		expect(text).toContain(
			'\t\t# clickjacking protection\n\t\tX-Frame-Options SAMEORIGIN\n\t\t-Server\n\t\tdefer\n\t}'
		);
		expect(text).toContain('\t\t# enable HSTS\n\t\tStrict-Transport-Security max-age=31536000;\n');

		const one1 = one('\theader @GET Cache-Control "max-age=3600" {\n\t\tmatch status 2xx\n\t}');
		const match = f(s, 'match', 'group').get(one1.node)!;
		expect(f(s, 'match-inline', 'list').get(match)).toEqual(['status', '2xx']);
		f(s, 'match-inline', 'list').set(match, ['status', '200']);
		f(s, 'value', 'text').set(one1.node, 'no-store');
		expect(one1.out()).toBe(
			'a.com {\n\theader @GET Cache-Control no-store {\n\t\tmatch status 200\n\t}\n}\n'
		);
		expect(s.describe!(one1.node)).toBe('Cache-Control');
	});

	it('request_header and request_body', () => {
		const h = one('\trequest_header -Referer');
		const s = spec('request_header');
		f(s, 'field', 'text').set(h.node, 'X-Id');
		f(s, 'value', 'text').set(h.node, '{http.request.uuid}');
		expect(h.out()).toBe('a.com {\n\trequest_header X-Id {http.request.uuid}\n}\n');

		const b = one('\trequest_body');
		const rb = spec('request_body');
		f(rb, 'max_size', 'text').set(b.node, '10MB');
		f(rb, 'set', 'text').set(b.node, '{"a": 1}');
		expect(b.out()).toBe('a.com {\n\trequest_body {\n\t\tmax_size 10MB\n\t\tset "{\\"a\\": 1}"\n\t}\n}\n');
	});

	it('vars: inline pair and block rows', () => {
		const v = one('\tvars /foo* isFoo "yep"');
		const s = spec('vars');
		f(s, 'value', 'text').set(v.node, 'nope nope');
		expect(v.out()).toBe('a.com {\n\tvars /foo* isFoo "nope nope"\n}\n');
		const b = one('\tvars {\n\t\t# boolean\n\t\tabc true\n\t}');
		f(s, 'vars', 'rows').set(b.node, [
			['abc', 'false'],
			['n', '1']
		]);
		expect(b.out()).toBe('a.com {\n\tvars {\n\t\t# boolean\n\t\tabc false\n\t\tn 1\n\t}\n}\n');
	});

	it('map: one output column per destination, default kept last', () => {
		const m = one('\tmap {host} {a} {b} {\n\t\tx.com 1 2\n\t\tdefault 0 0\n\t}');
		const s = spec('map');
		const rows = f(s, 'mappings', 'rows');
		expect(rows.columnsFor!(m.node).map((c) => c.label)).toEqual(['Input', '{a}', '{b}']);
		rows.set(m.node, [
			['x.com', '1', '2'],
			['~.*\\.net$', '-', '7']
		]);
		f(s, 'default', 'list').set(m.node, ['9', '9']);
		expect(m.out()).toBe(
			'a.com {\n\tmap {host} {a} {b} {\n\t\tx.com 1 2\n\t\t~.*\\.net$ - 7\n\t\tdefault 9 9\n\t}\n}\n'
		);
	});

	it('method and encode', () => {
		const m = one('\tmethod /api* POST');
		f(spec('method'), 'method', 'text').set(m.node, 'PUT');
		expect(m.out()).toBe('a.com {\n\tmethod /api* PUT\n}\n');

		const e = one('\tencode zstd gzip');
		const s = spec('encode');
		const formats = f(s, 'formats', 'list');
		expect(formats.get(e.node)).toEqual(['zstd', 'gzip']);
		f(s, 'gzip', 'text').set(e.node, '5');
		f(s, 'minimum_length', 'text').set(e.node, '1024');
		expect(e.out()).toBe('a.com {\n\tencode zstd {\n\t\tgzip 5\n\t\tminimum_length 1024\n\t}\n}\n');
		expect(formats.get(e.node)).toEqual(['zstd', 'gzip']);
		formats.set(e.node, ['zstd']);
		f(s, 'gzip', 'text').set(e.node, undefined);
		expect(e.out()).toBe('a.com {\n\tencode zstd {\n\t\tminimum_length 1024\n\t}\n}\n');
	});

	it('push: resources with an optional method', () => {
		const p = one('\tpush /index.html {\n\t\tGET /app.js\n\t\t/style.css\n\t}');
		const rows = f(spec('push'), 'resources', 'rows');
		expect(rows.get(p.node)).toEqual([
			['GET', '/app.js'],
			['', '/style.css']
		]);
		rows.set(p.node, [
			['HEAD', '/app.js'],
			['', '/style.css'],
			['', '/font.woff2']
		]);
		expect(p.out()).toBe(
			'a.com {\n\tpush /index.html {\n\t\tHEAD /app.js\n\t\t/style.css\n\t\t/font.woff2\n\t}\n}\n'
		);
	});

	it('respond and error: text and status share the arguments', () => {
		const s = spec('respond');
		const r = one('\trespond /health-check 200');
		expect(f(s, 'text', 'text').get(r.node)).toBeUndefined();
		expect(f(s, 'status', 'text').get(r.node)).toBe('200');
		f(s, 'text', 'text').set(r.node, 'OK');
		expect(r.out()).toBe('a.com {\n\trespond /health-check OK 200\n}\n');
		f(s, 'status', 'text').set(r.node, undefined);
		f(s, 'close', 'toggle').set(r.node, true);
		expect(r.out()).toBe('a.com {\n\trespond /health-check OK {\n\t\tclose\n\t}\n}\n');

		const e = spec('error');
		const x = one('\terror /private* "Unauthorized" 403');
		expect(f(e, 'text', 'text').get(x.node)).toBe('Unauthorized');
		f(e, 'status', 'text').set(x.node, '401');
		expect(x.out()).toBe('a.com {\n\terror /private* "Unauthorized" 401\n}\n');
		f(e, 'text', 'text').set(x.node, undefined);
		expect(x.out()).toBe('a.com {\n\terror /private* 401\n}\n');
		expect(spec('abort').fields.map((y) => y.kind)).toEqual(['note']);
	});

	it('intercept: replace_status rows with an optional response matcher', () => {
		const i = one('\tintercept {\n\t\t@e status 404\n\t\treplace_status @e 200\n\t}');
		const rows = f(spec('intercept'), 'replace_status', 'rows');
		expect(rows.get(i.node)).toEqual([['@e', '200']]);
		rows.set(i.node, [
			['@e', '204'],
			['', '500']
		]);
		expect(i.out()).toBe(
			'a.com {\n\tintercept {\n\t\t@e status 404\n\t\treplace_status @e 204\n\t\treplace_status 500\n\t}\n}\n'
		);
		rows.set(i.node, [['', '500']]);
		expect(i.out()).toBe('a.com {\n\tintercept {\n\t\t@e status 404\n\t\treplace_status 500\n\t}\n}\n');
	});

	it('invoke, bind, metrics, tracing, timeouts', () => {
		const v = one('\tinvoke app-proxy');
		f(spec('invoke'), 'route', 'text').set(v.node, 'other');
		expect(v.out()).toBe('a.com {\n\tinvoke other\n}\n');

		const b = one('\tbind 127.0.0.1');
		f(spec('bind'), 'hosts', 'list').set(b.node, ['127.0.0.1', '[::1]']);
		expect(b.out()).toBe('a.com {\n\tbind 127.0.0.1 [::1]\n}\n');

		const m = one('\tmetrics /metrics');
		f(spec('metrics'), 'disable_openmetrics', 'toggle').set(m.node, true);
		expect(m.out()).toBe('a.com {\n\tmetrics /metrics {\n\t\tdisable_openmetrics\n\t}\n}\n');

		const t = one('\ttracing');
		const ts = spec('tracing');
		f(ts, 'span', 'text').set(t.node, 'api');
		const attrs = f(ts, 'span_attributes', 'group').create(t.node);
		f(ts, 'attributes', 'rows').set(attrs, [['user_id', '{http.request.cookie.user-id}']]);
		expect(t.out()).toBe(
			'a.com {\n\ttracing {\n\t\tspan api\n\t\tspan_attributes {\n\t\t\tuser_id {http.request.cookie.user-id}\n\t\t}\n\t}\n}\n'
		);

		const o = one('\ttimeouts /upload* {\n\t\tread_timeout 10s 1024\n\t}');
		const os = spec('timeouts');
		expect(f(os, 'read_timeout#1', 'text').get(o.node)).toBe('1024');
		f(os, 'read_timeout#1', 'text').set(o.node, undefined);
		f(os, 'write_timeout', 'text').set(o.node, '30s');
		f(os, 'write_timeout#1', 'text').set(o.node, '2048');
		expect(o.out()).toBe(
			'a.com {\n\ttimeouts /upload* {\n\t\tread_timeout 10s\n\t\twrite_timeout 30s 2048\n\t}\n}\n'
		);
	});

	it('basic_auth: users, algorithm and realm', () => {
		const a = one('\tbasic_auth /secret/* {\n\t\t# Bob\n\t\tBob $2a$14$hash\n\t}');
		const s = spec('basic_auth');
		f(s, 'users', 'rows').set(a.node, [
			['Bob', '$2a$14$hash'],
			['Ann', '$2a$14$other']
		]);
		f(s, 'realm', 'text').set(a.node, 'private');
		expect(a.out()).toBe(
			'a.com {\n\tbasic_auth /secret/* bcrypt private {\n\t\t# Bob\n\t\tBob $2a$14$hash\n\t\tAnn $2a$14$other\n\t}\n}\n'
		);
		expect(s.describe!(a.node)).toBe('2 users');
	});

	it('root, fs, templates', () => {
		const r = one('\troot * /srv');
		f(spec('root'), 'path', 'text').set(r.node, '/srv/www');
		expect(r.out()).toBe('a.com {\n\troot * /srv/www\n}\n');

		const x = one('\tfs /images* foo');
		f(spec('fs'), 'filesystem', 'text').set(x.node, 's3');
		expect(x.out()).toBe('a.com {\n\tfs /images* s3\n}\n');

		const t = one('\ttemplates');
		const s = spec('templates');
		f(s, 'between', 'text').set(t.node, '[[');
		f(s, 'between#1', 'text').set(t.node, ']]');
		f(s, 'mime', 'list').set(t.node, ['text/html', 'application/json']);
		expect(t.out()).toBe(
			'a.com {\n\ttemplates {\n\t\tbetween [[ ]]\n\t\tmime text/html application/json\n\t}\n}\n'
		);
	});

	it('php_fastcgi: upstream, PHP options and the proxy sections without transport', () => {
		const p = one('\tphp_fastcgi app1:9000');
		const s = spec('php_fastcgi');
		expect(s.fields.some((x) => x.id === 'section:transport')).toBe(false);
		f(s, 'upstreams', 'list').set(p.node, ['unix//run/php/php-fpm.sock']);
		f(s, 'root', 'text').set(p.node, '/var/www/html/public');
		f(s, 'env', 'rows').set(p.node, [['APP_ENV', 'production']]);
		f(s, 'health_uri', 'text').set(p.node, '/ping');
		expect(p.out()).toBe(
			'a.com {\n\tphp_fastcgi unix//run/php/php-fpm.sock {\n\t\troot /var/www/html/public\n\t\tenv APP_ENV production\n\t\thealth_uri /ping\n\t}\n}\n'
		);
	});

	it('tls: certificate modes, DNS challenge, protocols', () => {
		const s = spec('tls');
		const mode = f(s, 'mode', 'select');
		const t = one('\ttls');
		expect(mode.get(t.node)).toBe('auto');
		mode.set(t.node, 'internal');
		expect(t.out()).toBe('a.com {\n\ttls internal\n}\n');
		mode.set(t.node, 'email');
		f(s, 'email', 'text').set(t.node, 'cakes@example.com');
		expect(mode.get(t.node)).toBe('email');
		expect(t.out()).toBe('a.com {\n\ttls cakes@example.com\n}\n');
		mode.set(t.node, 'files');
		f(s, 'cert', 'text').set(t.node, '/certs/a.pem');
		expect(t.out()).toBe('a.com {\n\ttls /certs/a.pem key.pem\n}\n');

		const d = one('\ttls');
		// The provider is a guided field of its own (dns-provider.test.ts); this is what it does for "other".
		expect(f(s, 'dns', 'custom').label).toBe('DNS provider');
		const line = chooseOther(d.node, 'cloudflare');
		findField(otherProviderFields, 'credentials', 'list').set(line, ['{env.CF_API_TOKEN}']);
		f(s, 'protocols', 'select').set(d.node, 'tls1.3');
		f(s, 'key_type', 'select').set(d.node, 'p384');
		f(s, 'on_demand', 'toggle').set(d.node, true);
		expect(d.out()).toBe(
			'a.com {\n\ttls {\n\t\tdns cloudflare {env.CF_API_TOKEN}\n\t\tprotocols tls1.3\n\t\tkey_type p384\n\t\ton_demand\n\t}\n}\n'
		);
		expect(s.describe!(d.node)).toBe('Automatic');

		const i = one('\ttls {\n\t\tissuer acme https://ca.example/dir {\n\t\t\temail x@example.com\n\t\t}\n\t}');
		const issuer = f(s, 'issuer', 'variant');
		const cur = issuer.get(i.node)!;
		expect(cur.value).toBe('acme');
		const acme = issuer.options.find((o) => o.value === 'acme')!;
		const dir = findField(acme.fields, 'arg1', 'text');
		expect(dir.get(cur.node)).toBe('https://ca.example/dir');
		dir.set(cur.node, 'https://other.example/dir');
		expect(i.out()).toContain('issuer acme https://other.example/dir {');
	});

	it('acme_server: CA, lifetime, challenges, allow and deny', () => {
		const a = one('\tacme_server {\n\t\tca home\n\t}');
		const s = spec('acme_server');
		f(s, 'lifetime', 'text').set(a.node, '24h');
		f(s, 'challenges', 'list').set(a.node, ['http-01', 'dns-01']);
		const allow = f(s, 'allow', 'group').create(a.node);
		findField(f(s, 'allow', 'group').fields, 'domains', 'list').set(allow, ['*.home.arpa']);
		expect(a.out()).toBe(
			'a.com {\n\tacme_server {\n\t\tca home\n\t\tlifetime 24h\n\t\tchallenges http-01 dns-01\n\t\tallow {\n\t\t\tdomains *.home.arpa\n\t\t}\n\t}\n}\n'
		);
	});
});

describe('W5b matcher edits', () => {
	/** Parse `@m <module …>` inside a site and return the module node. */
	function mod(line: string) {
		const r = parse(`a.com {\n\t${line}\n}\n`);
		const def = (r.file.blocks[0] as SiteBlock).body[0] as MatcherDef;
		const node = (def.inline ?? def.body!.find((n): n is Directive => n.kind === 'directive'))!;
		return { node, out: () => print(r.file) };
	}

	it('client_ip, remote_ip, host, method', () => {
		const c = mod('@p client_ip private_ranges');
		f(mspec('client_ip'), 'args0', 'list').set(c.node, ['private_ranges', '100.64.0.0/10']);
		expect(c.out()).toBe('a.com {\n\t@p client_ip private_ranges 100.64.0.0/10\n}\n');
		const r = mod('@p remote_ip 10.0.0.0/8');
		f(mspec('remote_ip'), 'args0', 'list').set(r.node, ['192.168.0.0/16']);
		expect(r.out()).toBe('a.com {\n\t@p remote_ip 192.168.0.0/16\n}\n');
		const h = mod('@h host a.example.com');
		f(mspec('host'), 'args0', 'list').set(h.node, ['a.example.com', 'b.example.com']);
		expect(h.out()).toBe('a.com {\n\t@h host a.example.com b.example.com\n}\n');
		const m = mod('@m method GET');
		f(mspec('method'), 'args0', 'list').set(m.node, ['PUT', 'DELETE']);
		expect(m.out()).toBe('a.com {\n\t@m method PUT DELETE\n}\n');
	});

	it('file: inline list and block options', () => {
		const x = mod('@html file {\n\t\ttry_files {path}.html {path}\n\t}');
		const s = mspec('file');
		f(s, 'try_policy', 'select').set(x.node, 'smallest_size');
		f(s, 'try_files', 'list').set(x.node, ['{path}.html', '{path}', '=404']);
		expect(x.out()).toBe(
			'a.com {\n\t@html file {\n\t\ttry_files {path}.html {path} =404\n\t\ttry_policy smallest_size\n\t}\n}\n'
		);
		const i = mod('@f file {path}.html');
		f(s, 'args0', 'list').set(i.node, ['{path}.html', '{path}']);
		expect(i.out()).toBe('a.com {\n\t@f file {path}.html {path}\n}\n');
	});

	it('header: value, and absent with !', () => {
		const s = mspec('header');
		const h = mod('@up header Connection *Upgrade*');
		expect(f(s, 'field', 'text').get(h.node)).toBe('Connection');
		f(s, 'absent', 'toggle').set(h.node, true);
		expect(h.out()).toBe('a.com {\n\t@up header !Connection\n}\n');
		f(s, 'field', 'text').set(h.node, 'Upgrade');
		expect(h.out()).toBe('a.com {\n\t@up header !Upgrade\n}\n');
		f(s, 'absent', 'toggle').set(h.node, false);
		f(s, 'value', 'text').set(h.node, 'websocket');
		expect(h.out()).toBe('a.com {\n\t@up header Upgrade websocket\n}\n');
	});

	it('header_regexp and vars_regexp: the optional capture name', () => {
		const s = mspec('header_regexp');
		const h = mod('@login header_regexp Cookie login_([a-f0-9]+)');
		expect(f(s, 'name', 'text').get(h.node)).toBeUndefined();
		expect(f(s, 'field', 'text').get(h.node)).toBe('Cookie');
		f(s, 'name', 'text').set(h.node, 'login');
		expect(h.out()).toBe('a.com {\n\t@login header_regexp login Cookie login_([a-f0-9]+)\n}\n');
		f(s, 'regexp', 'text').set(h.node, 'sid_(.+)');
		f(s, 'name', 'text').set(h.node, undefined);
		expect(h.out()).toBe('a.com {\n\t@login header_regexp Cookie sid_(.+)\n}\n');

		const v = mod('@magic vars_regexp magic {magic_number} ^(4.*)');
		const vs = mspec('vars_regexp');
		expect(f(vs, 'variable', 'text').get(v.node)).toBe('{magic_number}');
		f(vs, 'variable', 'text').set(v.node, '{n}');
		expect(v.out()).toBe('a.com {\n\t@magic vars_regexp magic {n} ^(4.*)\n}\n');
	});

	it('protocol, tls, url_pattern, vars', () => {
		const p = mod('@h2 protocol http/2+');
		f(mspec('protocol'), 'protocol', 'text').set(p.node, 'grpc');
		expect(p.out()).toBe('a.com {\n\t@h2 protocol grpc\n}\n');

		const t = mod('@early tls early_data');
		f(mspec('tls'), 'state', 'select').set(t.node, undefined);
		expect(t.out()).toBe('a.com {\n\t@early tls\n}\n');

		const u = mod('@book url_pattern /books/:id');
		const us = mspec('url_pattern');
		f(us, 'base_url', 'text').set(u.node, 'https://example.com');
		f(us, 'ignore_case', 'toggle').set(u.node, true);
		expect(u.out()).toBe(
			'a.com {\n\t@book url_pattern /books/:id {\n\t\tbase_url https://example.com\n\t\tignore_case\n\t}\n}\n'
		);

		const v = mod('@magic vars {magic_number} 3 5');
		f(mspec('vars'), 'args1', 'list').set(v.node, ['3', '5', '7']);
		expect(v.out()).toBe('a.com {\n\t@magic vars {magic_number} 3 5 7\n}\n');
	});

	it('query: key/value rows and the empty query toggle', () => {
		const s = mspec('query');
		const q = mod('@sorted query sort=asc sort=desc');
		const pairs = f(s, 'pairs', 'rows');
		expect(pairs.get(q.node)).toEqual([
			['sort', 'asc'],
			['sort', 'desc']
		]);
		pairs.set(q.node, [
			['sort', 'asc'],
			['q', '*'],
			['', '']
		]);
		expect(q.out()).toBe('a.com {\n\t@sorted query sort=asc q=*\n}\n');
		f(s, 'no-query', 'toggle').set(q.node, true);
		expect(q.out()).toBe('a.com {\n\t@sorted query ""\n}\n');
		expect(f(s, 'no-query', 'toggle').get(q.node)).toBe(true);
	});
});
