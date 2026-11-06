import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { format, parse, print, type Directive, type MatcherDef, type SiteBlock } from '@caddy-ui/caddyfile';
import { schema } from '@caddy-ui/caddy-schema';
import {
	childrenOf,
	editDocument,
	loadDocument,
	parsePathKey,
	pathAt,
	pathKey,
	resolvePath,
	type NodePath
} from './document';
import { flattenTree } from './tree';
import {
	bespokeDirectiveNames,
	bespokeMatcherNames,
	formForDirective,
	formForGlobalOption,
	formForMatcher,
	type FieldSpec,
	type FormContext,
	type FormSpec
} from './forms';
import { celOf, celOfSet, captureGroups, matcherPreview, readMatcherDef, writeMatcherDef } from './matcher';
import { availablePlaceholders, placeholderContext } from './placeholders';
import { effectiveOrderView } from './order';
import { RECIPES, RecipeError, recipeById, renderRecipe } from './recipes';
import {
	addableNames,
	formContextFor,
	formForPath,
	leadingBlanks,
	matcherInsertIndex,
	nodesFromRaw,
	rawTextOf,
	roleOf,
	setSiteAddresses,
	uniqueMatcherName
} from './inspect';

const sample = readFileSync(
	new URL('../../../../../packages/caddy-schema/test/fixtures/sample-home.Caddyfile', import.meta.url),
	'utf8'
);

const ctx: FormContext = {
	matcherNames: [],
	snippetNames: [],
	placeholders: [],
	inSnippet: false,
	holdsDirectives: true
};

const site = (text: string, name: string) =>
	parse(text).file.blocks.find((b): b is SiteBlock => b.kind === 'site' && b.addresses[0]?.text === name)!;

/** Read every visible field and write the same value back; the text must not change. */
function roundTrip(spec: FormSpec, node: Directive) {
	const visit = (fields: readonly FieldSpec[], target: Directive) => {
		for (const f of fields) {
			if ('when' in f && f.when && !f.when(target, ctx)) continue;
			switch (f.kind) {
				case 'text':
				case 'select':
					f.set(target, f.get(target));
					break;
				case 'toggle':
					f.set(target, f.get(target));
					break;
				case 'list':
					f.set(target, f.get(target));
					break;
				case 'rows':
					f.set(target, f.get(target));
					break;
				case 'group': {
					const sub = f.get(target);
					if (sub) visit(f.fields, sub);
					break;
				}
				case 'variant': {
					const cur = f.get(target);
					if (cur) {
						const sub = f.set(target, cur.value);
						const opt = f.options.find((o) => o.value === cur.value);
						if (sub && opt) visit(opt.fields, sub);
					}
					break;
				}
				case 'section':
					visit(f.fields, target);
					break;
			}
		}
	};
	visit(spec.fields, node);
}

const DAVIDS_DIRECTIVES = [
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

describe('document model', () => {
	it('loads the fixture losslessly and addresses nodes by path', () => {
		const doc = loadDocument(sample, schema);
		expect(print(doc.file)).toBe(sample);
		const path: NodePath = { block: 12, nodes: [3, 0, 2] };
		expect(parsePathKey(pathKey(path))).toEqual(path);
		expect(parsePathKey('4')).toEqual({ block: 4, nodes: [] });
		const r = resolvePath(doc.file, path)!;
		expect(r.block.kind).toBe('site');
		expect((r.node as Directive).name.text).toBe('reverse_proxy');
		expect(r.parent).toBe(childrenOf(resolvePath(doc.file, { block: 12, nodes: [3, 0] })!.target));
		expect(resolvePath(doc.file, { block: 12, nodes: [99] })).toBeNull();
	});

	it('finds the innermost node at an offset', () => {
		const doc = loadDocument(sample, schema);
		const at = sample.indexOf('uri strip_prefix /~user/project/archive');
		const path = pathAt(doc.file, at)!;
		const r = resolvePath(doc.file, path)!;
		expect((r.node as Directive).name.text).toBe('uri');
		expect(path.nodes.length).toBe(3);
	});

	it('edits one node and leaves every other byte alone', () => {
		let doc = loadDocument(sample, schema);
		doc = editDocument(doc, schema, (file) => {
			const s = file.blocks.find(
				(b) => b.kind === 'site' && b.addresses[0]!.text === 'me.example.com'
			) as SiteBlock;
			const rp = s.body[0] as Directive;
			rp.args[0]!.text = '10.0.0.103:12345';
			delete rp.args[0]!.raw;
		});
		expect(doc.text).toBe(sample.replace('reverse_proxy 10.0.0.103:11081', 'reverse_proxy 10.0.0.103:12345'));
		expect(doc.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
	});
});

describe('tree', () => {
	it('flattens blocks with names, summaries and notes', () => {
		const doc = loadDocument(sample, schema);
		const rows = flattenTree(doc.file, { expanded: new Set(['12', '12:3']) });
		const names = rows.filter((r) => r.depth === 0).map((r) => r.name);
		expect(names[0]).toBe('Global options');
		expect(names[1]).toBe('(tinyauth_forwarder)');
		expect(names).toContain('example.com, www.example.com');
		const big = rows.filter((r) => r.path.block === 12);
		expect(big.map((r) => r.name)).toEqual([
			'example.com, www.example.com',
			'@protected',
			'@project',
			'redir',
			'handle',
			'route',
			'handle',
			'handle'
		]);
		expect(big[1]!.summary).toBe('path /edit* /preview* /admin*');
		expect(big[4]!.matcher).toBe('/~user/project/archive/*');
		const safeIndex = doc.file.blocks.findIndex(
			(b) => b.kind === 'site' && b.addresses[0]!.text === 'safe.example.com'
		);
		const safe = flattenTree(doc.file, { expanded: new Set([`${safeIndex}`, `${safeIndex}:0`]) }).filter(
			(r) => r.path.block === safeIndex
		);
		expect(safe.find((r) => r.name === '@username')?.note).toBe('Capture username: first segment after /u/');
		expect(safe.find((r) => r.name === 'reverse_proxy')?.summary).toBe('→ 10.0.0.102:3923');
	});

	it('filters by a query but keeps ancestors', () => {
		const doc = loadDocument(sample, schema);
		const rows = flattenTree(doc.file, { expanded: new Set(), query: 'pstuff' });
		expect(rows.map((r) => r.name)).toEqual(['safe.example.com', 'handle', '@pstuff', 'redir']);
	});
});

describe('bespoke forms', () => {
	it('exist for the 12 directives and the matchers David uses', () => {
		for (const d of DAVIDS_DIRECTIVES) expect(formForDirective(schema, d).source, d).toBe('bespoke');
		expect(bespokeDirectiveNames()).toEqual([...DAVIDS_DIRECTIVES].sort());
		for (const m of ['path', 'path_regexp', 'expression', 'not'])
			expect(formForMatcher(schema, m).source, m).toBe('bespoke');
		expect(bespokeMatcherNames()).toEqual(['expression', 'not', 'path', 'path_regexp']);
		expect(formForDirective(schema, 'respond').source).toBe('schema');
		expect(formForDirective(schema, 'my_plugin').source).toBe('unknown');
		expect(formForGlobalOption(schema, 'servers').source).toBe('bespoke');
		expect(formForGlobalOption(schema, 'debug').source).toBe('schema');
	});

	it('round-trip every directive of the fixture through its form without changing the text', () => {
		const { file } = parse(sample);
		let count = 0;
		const visit = (nodes: readonly import('@caddy-ui/caddyfile').Node[]) => {
			for (const n of nodes) {
				if (n.kind === 'directive') {
					roundTrip(formForDirective(schema, n.name.text).spec, n);
					count++;
					if (n.body) visit(n.body);
				} else if (n.kind === 'matcher') {
					const mods = n.inline ? [n.inline] : (n.body ?? []);
					for (const m of mods)
						if (m.kind === 'directive') {
							roundTrip(formForMatcher(schema, m.name.text).spec, m);
							count++;
						}
				}
			}
		};
		for (const b of file.blocks) if (b.kind === 'site' || b.kind === 'snippet') visit(b.body);
		expect(count).toBeGreaterThan(60);
		expect(print(file)).toBe(sample);
	});

	it('round-trips the docs examples of the 12 directives', () => {
		let examples = 0;
		for (const name of DAVIDS_DIRECTIVES) {
			for (const ex of schema.directives[name]!.examples) {
				const r = parse(ex);
				const visit = (nodes: readonly import('@caddy-ui/caddyfile').Node[]) => {
					for (const n of nodes) {
						if (n.kind !== 'directive') continue;
						if (n.name.text === name) {
							roundTrip(formForDirective(schema, name).spec, n);
							examples++;
						}
						if (n.body) visit(n.body);
					}
				};
				for (const b of r.file.blocks) {
					if (b.kind === 'import') visit([b.node]);
					else if (b.kind !== 'raw') visit(b.body);
				}
				expect(print(r.file), `${name}: ${ex}`).toBe(ex);
			}
		}
		expect(examples).toBeGreaterThan(40);
	});

	it('W5a definition of done: open every block, save with no changes, the file is caddy fmt style with every comment', () => {
		const doc = loadDocument(sample, schema);
		const { file } = parse(doc.text);
		for (const b of file.blocks) {
			if (b.kind !== 'site' && b.kind !== 'snippet') continue;
			for (const n of b.body)
				if (n.kind === 'directive') roundTrip(formForDirective(schema, n.name.text).spec, n);
		}
		const saved = format(print(file));
		expect(saved).toBe(format(sample));
		const comments = (t: string) =>
			t
				.split('\n')
				.filter((l) => l.trim().startsWith('#'))
				.map((l) => l.trim());
		expect(comments(saved)).toEqual(comments(sample));
		expect(format(saved)).toBe(saved);
		expect(saved).not.toBe(sample); // the fixture mixes 2, 4, 6 and 8 spaces; caddy fmt uses tabs
	});

	it('reverse_proxy: upstreams, headers, transport and health fields write the right lines', () => {
		const text =
			'prox.example.com {\n\treverse_proxy * {\n\t\tto https://10.0.0.1:8006\n\t\tlb_policy ip_hash\n\t\ttransport http {\n\t\t\ttls_insecure_skip_verify\n\t\t\ttls_server_name prox.example.com\n\t\t}\n\t\theader_up Upgrade {http.request.header.Upgrade}\n\t}\n}\n';
		const r = parse(text);
		const rp = (r.file.blocks[0] as SiteBlock).body[0] as Directive;
		const spec = formForDirective(schema, 'reverse_proxy').spec;
		const field = (id: string, fields: readonly FieldSpec[] = spec.fields): FieldSpec | undefined => {
			for (const f of fields) {
				if ('id' in f && f.id === id) return f;
				if (f.kind === 'section') {
					const hit = field(id, f.fields);
					if (hit) return hit;
				}
			}
			return undefined;
		};
		const upstreams = field('upstreams')! as Extract<FieldSpec, { kind: 'list' }>;
		expect(upstreams.get(rp)).toEqual(['https://10.0.0.1:8006']);
		upstreams.set(rp, ['https://10.0.0.1:8006', 'https://10.0.0.2:8006']);
		const headerUp = field('header_up')! as Extract<FieldSpec, { kind: 'rows' }>;
		expect(headerUp.get(rp)).toEqual([['Upgrade', '{http.request.header.Upgrade}']]);
		headerUp.set(rp, [
			['Upgrade', '{http.request.header.Upgrade}'],
			['Connection', '{http.request.header.Connection}'],
			['-X-Secret', '']
		]);
		const transport = field('transport')! as Extract<FieldSpec, { kind: 'variant' }>;
		const t = transport.get(rp)!;
		expect(t.value).toBe('http');
		const http = transport.options.find((o) => o.value === 'http')!;
		const skip = http.fields.find((f) => f.id === 'tls_insecure_skip_verify') as Extract<
			FieldSpec,
			{ kind: 'toggle' }
		>;
		expect(skip.get(t.node)).toBe(true);
		skip.set(t.node, false);
		const sni = http.fields.find((f) => f.id === 'tls_server_name') as Extract<FieldSpec, { kind: 'text' }>;
		sni.set(t.node, 'proxmox.local');
		const lb = field('lb_policy')! as Extract<FieldSpec, { kind: 'variant' }>;
		expect(lb.get(rp)?.value).toBe('ip_hash');
		lb.set(rp, 'least_conn');
		const health = field('health_uri')! as Extract<FieldSpec, { kind: 'text' }>;
		health.set(rp, '/healthz');
		expect(print(r.file)).toBe(
			'prox.example.com {\n\treverse_proxy * {\n\t\tto https://10.0.0.1:8006 https://10.0.0.2:8006\n\t\tlb_policy least_conn\n\t\ttransport http {\n\t\t\ttls_server_name proxmox.local\n\t\t}\n\t\theader_up Upgrade {http.request.header.Upgrade}\n\t\theader_up Connection {http.request.header.Connection}\n\t\theader_up -X-Secret\n\t\thealth_uri /healthz\n\t}\n}\n'
		);
		// removing the last body line drops the braces
		const simple = parse('a.com {\n\treverse_proxy 10.0.0.1:80 {\n\t\thealth_uri /x\n\t}\n}\n');
		health.set((simple.file.blocks[0] as SiteBlock).body[0] as Directive, undefined);
		expect(print(simple.file)).toBe('a.com {\n\treverse_proxy 10.0.0.1:80\n}\n');
	});

	it('forward_auth reads uri and copy_headers, and keeps the block form of copy_headers', () => {
		const spec = formForDirective(schema, 'forward_auth').spec;
		const snippet = parse(sample).file.blocks[1]!;
		const fa = (snippet as Extract<typeof snippet, { kind: 'snippet' }>).body[0] as Directive;
		const uri = spec.fields.find((f) => f.id === 'uri') as Extract<FieldSpec, { kind: 'text' }>;
		const copy = spec.fields.find((f) => f.id === 'copy_headers') as Extract<FieldSpec, { kind: 'list' }>;
		expect(uri.get(fa)).toBe('/api/auth/caddy');
		expect(copy.get(fa)).toEqual(['Remote-User', 'Remote-Name', 'Remote-Email', 'Remote-Groups']);
		expect(spec.describe!(fa)).toBe('→ 10.0.0.103:8888 /api/auth/caddy');
		const block = parse(
			'a.com {\n\tforward_auth x:1 {\n\t\tcopy_headers {\n\t\t\tA\n\t\t\tB>C\n\t\t}\n\t}\n}\n'
		);
		const fa2 = (block.file.blocks[0] as SiteBlock).body[0] as Directive;
		expect(copy.get(fa2)).toEqual(['A', 'B>C']);
		copy.set(fa2, ['A', 'B>C', 'D']);
		expect(print(block.file)).toBe(
			'a.com {\n\tforward_auth x:1 {\n\t\tcopy_headers {\n\t\t\tA\n\t\t\tB>C\n\t\t\tD\n\t\t}\n\t}\n}\n'
		);
	});

	it('redir, rewrite, uri, try_files, file_server, import', () => {
		const r = parse(
			'a.com {\n\tredir https://b.com{uri} permanent\n\trewrite * ?x=1\n\turi strip_prefix /api\n\ttry_files {path} /index.html\n\tfile_server browse\n\timport tinyauth_forwarder arg1\n}\n'
		);
		const body = (r.file.blocks[0] as SiteBlock).body as Directive[];
		const [redir, rewrite, uri, tryFiles, fileServer, imp] = body as [
			Directive,
			Directive,
			Directive,
			Directive,
			Directive,
			Directive
		];
		const f = (name: string, id: string) => {
			const spec = formForDirective(schema, name).spec;
			const find = (fields: readonly FieldSpec[]): FieldSpec | undefined => {
				for (const x of fields) {
					if ('id' in x && x.id === id) return x;
					if (x.kind === 'section' || x.kind === 'group') {
						const hit = find(x.fields);
						if (hit) return hit;
					}
				}
				return undefined;
			};
			return find(spec.fields)!;
		};
		(f('redir', 'arg1') as Extract<FieldSpec, { kind: 'select' }>).set(redir, '308');
		(f('rewrite', 'arg0') as Extract<FieldSpec, { kind: 'text' }>).set(rewrite, '/new{uri}');
		(f('uri', 'arg0') as Extract<FieldSpec, { kind: 'select' }>).set(uri, 'replace');
		(f('uri', 'find') as Extract<FieldSpec, { kind: 'text' }>).set(uri, '/docs/');
		(f('uri', 'replace-with') as Extract<FieldSpec, { kind: 'text' }>).set(uri, '/v1/docs/');
		(f('try_files', 'policy') as Extract<FieldSpec, { kind: 'select' }>).set(
			tryFiles,
			'first_exist_fallback'
		);
		(f('file_server', 'browse-arg') as Extract<FieldSpec, { kind: 'toggle' }>).set(fileServer, false);
		(f('file_server', 'root') as Extract<FieldSpec, { kind: 'text' }>).set(fileServer, '/srv/www');
		(f('file_server', 'hide') as Extract<FieldSpec, { kind: 'list' }>).set(fileServer, ['.git', '.env']);
		(f('file_server', 'precompressed') as Extract<FieldSpec, { kind: 'list' }>).set(fileServer, [
			'zstd',
			'gzip'
		]);
		(f('import', 'pattern') as Extract<FieldSpec, { kind: 'text' }>).set(imp, 'other');
		(f('import', 'args1') as Extract<FieldSpec, { kind: 'list' }>).set(imp, ['a b', 'c']);
		expect(print(r.file)).toBe(
			'a.com {\n\tredir https://b.com{uri} 308\n\trewrite * /new{uri}\n\turi replace /docs/ /v1/docs/\n\ttry_files {path} /index.html {\n\t\tpolicy first_exist_fallback\n\t}\n\tfile_server {\n\t\troot /srv/www\n\t\thide .git .env\n\t\tprecompressed zstd gzip\n\t}\n\timport other "a b" c\n}\n'
		);
	});

	it('generic schema forms cover a directive without a bespoke form', () => {
		const r = parse('a.com {\n\trespond "hello" 200\n\tencode zstd gzip {\n\t\tminimum_length 512\n\t}\n}\n');
		const [respond, encode] = (r.file.blocks[0] as SiteBlock).body as [Directive, Directive];
		roundTrip(formForDirective(schema, 'respond').spec, respond);
		roundTrip(formForDirective(schema, 'encode').spec, encode);
		expect(print(r.file)).toBe(
			'a.com {\n\trespond "hello" 200\n\tencode zstd gzip {\n\t\tminimum_length 512\n\t}\n}\n'
		);
		const enc = formForDirective(schema, 'encode').spec;
		const min = enc.fields.find((f) => f.id === 'minimum_length') as Extract<FieldSpec, { kind: 'text' }>;
		expect(min.get(encode)).toBe('512');
	});
});

describe('matcher model', () => {
	it('reads and writes inline, block and CEL forms', () => {
		const r = parse(
			'a.com {\n\t@a path /x /y\n\t@b {\n\t\t# only posts\n\t\tmethod POST\n\t\theader X-Foo bar\n\t}\n\t@c `{method} == "GET"`\n}\n'
		);
		const [a, b, c] = (r.file.blocks[0] as SiteBlock).body as [MatcherDef, MatcherDef, MatcherDef];
		expect(readMatcherDef(a)).toEqual({
			name: '@a',
			form: 'inline',
			modules: [{ name: 'path', args: ['/x', '/y'] }]
		});
		expect(readMatcherDef(b).modules).toEqual([
			{ name: 'method', args: ['POST'] },
			{ name: 'header', args: ['X-Foo', 'bar'] }
		]);
		expect(readMatcherDef(c)).toEqual({ name: '@c', form: 'cel', modules: [], cel: '{method} == "GET"' });
		// add a module to the inline one: it becomes a block
		writeMatcherDef(a, {
			name: '@a',
			form: 'inline',
			modules: [
				{ name: 'path', args: ['/x'] },
				{ name: 'method', args: ['GET'] }
			]
		});
		// change the block's second module, keep the comment
		writeMatcherDef(b, {
			name: '@b',
			form: 'block',
			modules: [
				{ name: 'method', args: ['POST', 'PUT'] },
				{ name: 'host', args: ['a.com'] }
			]
		});
		writeMatcherDef(c, { name: '@c', form: 'cel', modules: [], cel: '{method} == "POST"' });
		expect(print(r.file)).toBe(
			'a.com {\n\t@a {\n\t\tpath /x\n\t\tmethod GET\n\t}\n\t@b {\n\t\t# only posts\n\t\tmethod POST PUT\n\t\thost a.com\n\t}\n\t@c `{method} == "POST"`\n}\n'
		);
		writeMatcherDef(b, { name: '@b', form: 'inline', modules: [{ name: 'path', args: ['/z'] }] });
		expect(print(r.file)).toContain('\t@b path /z\n');
	});

	it('previews and gives the CEL equivalent', () => {
		expect(
			matcherPreview({ name: 'api', form: 'inline', modules: [{ name: 'path', args: ['/api/*'] }] })
		).toBe('@api path /api/*');
		expect(celOf(schema, { name: 'path', args: ['/a', '/b'] })).toBe("path('/a', '/b')");
		expect(celOf(schema, { name: 'header', args: ['X-Foo', 'bar'] })).toBe("header({'X-Foo': 'bar'})");
		expect(celOf(schema, { name: 'not', args: ['path', '/x'] })).toBe("!(path('/x'))");
		expect(
			celOfSet(schema, {
				name: 'x',
				form: 'block',
				modules: [
					{ name: 'path', args: ['/a'] },
					{ name: 'method', args: ['GET'] }
				]
			})
		).toBe("(path('/a')) && (method('GET'))");
		expect(captureGroups('^/u/([^/]+)/p/(.*)$')).toEqual({ count: 2, names: [] });
		expect(captureGroups('^/(?P<user>[^/]+)/(?:x|y)$')).toEqual({ count: 1, names: ['user'] });
	});
});

describe('placeholders', () => {
	it('offers regexp captures only where a matcher defines them', () => {
		const doc = loadDocument(sample, schema);
		const safe = doc.file.blocks.findIndex(
			(b) => b.kind === 'site' && b.addresses[0]!.text === 'safe.example.com'
		);
		const ctx = placeholderContext(doc.file, { block: safe, nodes: [0, 2] }); // the redir inside handle /u/*
		expect(ctx.captures.map((c) => c.name)).toEqual(['username', 'pstuff']);
		const list = availablePlaceholders(schema, ctx);
		expect(list.slice(0, 4).map((p) => p.name)).toEqual([
			'{re.username.1}',
			'{re.username.2}',
			'{re.pstuff.1}',
			'{re.pstuff.2}'
		]);
		expect(list.some((p) => p.name === '{err.status_code}')).toBe(false);
		const plain = availablePlaceholders(schema, placeholderContext(doc.file, { block: 2, nodes: [0] }));
		expect(plain.some((p) => p.name === '{re.1}')).toBe(false);
		expect(plain.some((p) => p.name === '{uri}')).toBe(true);
		const errors = placeholderContext(doc.file, { block: 11, nodes: [1, 0] }); // try_files inside handle_errors
		expect(errors.inErrors).toBe(true);
		expect(availablePlaceholders(schema, errors).some((p) => p.name === '{err.status_code}')).toBe(true);
	});
});

describe('effective order', () => {
	it('sorts by Caddy order and flags when the file order differs', () => {
		const doc = loadDocument(sample, schema);
		const big = doc.file.blocks[12]!;
		const view = effectiveOrderView(schema, doc.file, big);
		expect(view.rows.map((r) => r.name)).toEqual(['redir', 'handle', 'handle', 'handle']);
		expect(view.differs).toBe(false);
		const mixed = parse('a.com {\n\treverse_proxy x:1\n\tredir /a /b\n\tencode gzip\n\tmy_plugin\n}\n');
		const v = effectiveOrderView(schema, mixed.file, mixed.file.blocks[0]!);
		expect(v.rows.map((r) => r.name)).toEqual(['redir', 'encode', 'reverse_proxy', 'my_plugin']);
		expect(v.differs).toBe(true);
		expect(v.unordered).toEqual(['my_plugin']);
		const route = effectiveOrderView(schema, doc.file, (big as SiteBlock).body[3]!.body![0]!);
		expect(route.literal).toBe(true);
		expect(route.rows.map((r) => r.name)).toEqual(['forward_auth', 'uri', 'reverse_proxy']);
	});
});

describe('recipes', () => {
	it('renders every recipe to a block that parses clean', () => {
		const values: Record<string, Record<string, string>> = {
			reverse_proxy: { upstream: '10.0.0.10:8080', websocket: 'on' },
			redirect: { target: 'https://example.com', keepPath: 'on', code: 'permanent' },
			static: { root: '/srv/www', browse: 'on', spa: 'on' },
			php: { root: '/srv/www', fpm: 'php:9000' },
			protected: { upstream: '10.0.0.10:8080', auth: '10.0.0.101:8888' },
			error_page: { upstream: '10.0.0.10:8080', page: '/usr/share/caddy/404.html' },
			snippet: { name: 'common' },
			blank: {}
		};
		for (const recipe of RECIPES) {
			const text = renderRecipe(
				recipe,
				{ addresses: ['new.example.com'], name: 'common' },
				values[recipe.id] ?? {}
			);
			const r = parse(text + '\n');
			expect(r.diagnostics, recipe.id).toEqual([]);
			expect(format(text + '\n'), recipe.id).toBe(text + '\n');
		}
		expect(
			renderRecipe(recipeById('reverse_proxy')!, { addresses: ['a.com'] }, { upstream: '10.0.0.1:80' })
		).toBe('a.com {\n\treverse_proxy 10.0.0.1:80\n}');
		expect(
			renderRecipe(
				recipeById('protected')!,
				{ addresses: ['a.com'] },
				{ upstream: '10.0.0.1:80', snippet: 'tinyauth_forwarder' }
			)
		).toBe('a.com {\n\timport tinyauth_forwarder\n\treverse_proxy 10.0.0.1:80\n}');
		expect(
			renderRecipe(
				recipeById('protected')!,
				{ addresses: ['a.com'] },
				{ upstream: '10.0.0.1:80', auth: '10.0.0.101:8888' }
			)
		).toBe(
			'a.com {\n\tforward_auth 10.0.0.101:8888 {\n\t\turi /api/auth/caddy\n\t\tcopy_headers Remote-User Remote-Name Remote-Email Remote-Groups\n\t}\n\treverse_proxy 10.0.0.1:80\n}'
		);
		expect(() => renderRecipe(recipeById('reverse_proxy')!, { addresses: ['a.com'] }, {})).toThrow(
			RecipeError
		);
		expect(() =>
			renderRecipe(recipeById('reverse_proxy')!, { addresses: ['a.com'] }, { upstream: 'a b' })
		).toThrow(/spaces/);
	});
});

describe('inspect: what the inspector shows for a path', () => {
	const text = [
		'{',
		'\temail a@b.c',
		'\tservers {',
		'\t\ttrusted_proxies static 10.0.0.0/8',
		'\t}',
		'}',
		'',
		'(auth) {',
		'\tforward_auth 10.0.0.1:80 {',
		'\t\turi /check',
		'\t}',
		'}',
		'',
		'a.com, b.com {',
		'\t@api {',
		'\t\tpath /api/*',
		'\t\tnot {',
		'\t\t\tmethod GET',
		'\t\t}',
		'\t}',
		'\thandle @api {',
		'\t\treverse_proxy 10.0.0.2:80 {',
		'\t\t\theader_up Host {host}',
		'\t\t\t@err status 500',
		'\t\t\thandle_response @err {',
		'\t\t\t\trespond "down"',
		'\t\t\t}',
		'\t\t}',
		'\t}',
		'\t"weird" line',
		'}',
		''
	].join('\n');
	const file = parse(text).file;
	const p = (key: string) => parsePathKey(key)!;

	it('classifies blocks, directives, options, matchers, modules and subdirectives', () => {
		expect(roleOf(file, p('0'))).toBe('block');
		expect(roleOf(file, p('0:0'))).toBe('global_option');
		expect(roleOf(file, p('0:1.0'))).toBe('subdirective');
		expect(roleOf(file, p('1:0'))).toBe('directive');
		expect(roleOf(file, p('1:0.0'))).toBe('subdirective');
		expect(roleOf(file, p('2:0'))).toBe('matcher');
		expect(roleOf(file, p('2:0.0'))).toBe('matcher_module');
		expect(roleOf(file, p('2:0.1.0'))).toBe('matcher_module');
		expect(roleOf(file, p('2:1'))).toBe('directive');
		expect(roleOf(file, p('2:1.0'))).toBe('directive');
		expect(roleOf(file, p('2:1.0.0'))).toBe('subdirective');
		expect(roleOf(file, p('2:1.0.1'))).toBe('response_matcher');
		expect(roleOf(file, p('2:1.0.2.0'))).toBe('directive');
		expect(roleOf(file, p('2:2'))).toBe('raw');
	});

	it('picks the form that matches the role', () => {
		expect(formForPath(schema, file, p('0:0'))?.spec.name).toBe('email');
		expect(formForPath(schema, file, p('0:1.0'))?.spec.name).toBe('trusted_proxies');
		expect(formForPath(schema, file, p('1:0'))?.source).toBe('bespoke');
		expect(formForPath(schema, file, p('1:0.0'))?.spec.name).toBe('uri');
		expect(formForPath(schema, file, p('2:0.0'))?.spec.name).toBe('path');
		expect(formForPath(schema, file, p('2:0.1.0'))?.spec.name).toBe('method');
		expect(formForPath(schema, file, p('2:1'))?.spec.container).toBe(true);
		expect(formForPath(schema, file, p('2:1.0.0'))?.spec.name).toBe('header_up');
		expect(formForPath(schema, file, p('2:1.0.2.0'))?.spec.name).toBe('respond');
		expect(formForPath(schema, file, p('2:0'))).toBeNull();
		expect(formForPath(schema, file, p('2:2'))).toBeNull();
		expect(formForPath(null, file, p('2:1.0'))?.source).toBe('bespoke');
	});

	it('builds the form context from where the node sits', () => {
		const c = formContextFor(schema, file, p('2:1'));
		expect(c.matcherNames).toEqual(['@api']);
		expect(c.snippetNames).toEqual(['auth']);
		expect(c.holdsDirectives).toBe(true);
		expect(c.inSnippet).toBe(false);
		expect(c.placeholders.some((x) => x.name === '{path}')).toBe(true);
		expect(formContextFor(schema, file, p('1:0')).inSnippet).toBe(true);
		expect(formContextFor(schema, file, p('2:1.0.0')).holdsDirectives).toBe(false);
	});

	it('offers the right names to add', () => {
		expect(addableNames(schema, file, p('0'))).toContain('email');
		expect(addableNames(schema, file, p('2'))).toContain('reverse_proxy');
		expect(addableNames(schema, file, p('2:1'))).toContain('file_server');
		expect(addableNames(schema, file, p('2:1.0'))).toContain('header_up');
		expect(addableNames(schema, file, p('2:1.0'))).not.toContain('file_server');
		expect(addableNames(schema, file, p('2:0'))).toContain('header');
	});

	it('sets site addresses keeping the comma style and prints raw text without indentation', () => {
		const s = file.blocks[2] as SiteBlock;
		expect(site(text, 'a.com').addresses.map((t) => t.text)).toEqual(['a.com', 'b.com']);
		setSiteAddresses(s, ['x.com', 'y.com', 'z.com']);
		expect(print(file)).toContain('\nx.com, y.com, z.com {\n');
		const spaced = parse('a.com b.com {\n}\n').file.blocks[0] as SiteBlock;
		setSiteAddresses(spaced, ['c.com', 'd.com']);
		expect(print(parse('a.com b.com {\n}\n').file)).toBe('a.com b.com {\n}\n');
		expect(spaced.addresses.map((t) => t.raw)).toEqual(['c.com', 'd.com']);
		const spacedOut = parse('a.com {\n\trespond a\n\n\t# note\n\trespond b\n}\n').file;
		const second = (spacedOut.blocks[0] as SiteBlock).body[1]!;
		expect(rawTextOf(second)).toBe('# note\nrespond b');
		expect(leadingBlanks(second)).toHaveLength(1);
		const rp = resolvePath(file, p('2:1.0'))!.node!;
		expect(rawTextOf(rp)).toBe(
			'reverse_proxy 10.0.0.2:80 {\n\theader_up Host {host}\n\t@err status 500\n\thandle_response @err {\n\t\trespond "down"\n\t}\n}'
		);
		expect(
			nodesFromRaw('encode gzip\nfile_server /x', true).map((n) =>
				n.kind === 'directive' ? n.name.text : ''
			)
		).toEqual(['encode', 'file_server']);
		expect(nodesFromRaw('file_server /x', true)[0]).toMatchObject({ matcher: { text: '/x' } });
		expect(nodesFromRaw('file_server /x', false)[0]).toMatchObject({ args: [{ text: '/x' }] });
	});

	it('names new matchers uniquely and places them after the existing ones', () => {
		const body = (file.blocks[2] as SiteBlock).body;
		expect(uniqueMatcherName(body)).toBe('@matcher');
		expect(uniqueMatcherName(body, 'api')).toBe('@api2');
		expect(matcherInsertIndex(body)).toBe(1);
		expect(matcherInsertIndex([])).toBe(0);
	});
});
