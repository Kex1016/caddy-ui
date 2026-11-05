import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schema } from '@caddy-ui/caddy-schema';
import { analyze, LineIndex, placeLineDiagnostics } from './analyze';
import { argumentOptions, lineStartOptions } from './assist';
import { cursorContext, findPlaceholder, openFrames, resolveScope, schemaFor } from './context';

const ROOT = join(import.meta.dirname, '../../../../..');
const SAMPLE = readFileSync(join(ROOT, 'packages/caddy-schema/test/fixtures/sample-home.Caddyfile'), 'utf8');

describe('analyze', () => {
	it("validates David's Caddyfile clean", () => {
		const { diagnostics } = analyze(SAMPLE, schema);
		expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
	});

	it('underlines a syntax error on the right line, fast enough for the 300 ms budget', () => {
		const broken = SAMPLE.replace('reverse_proxy 10.0.0.106:8888', 'reverse_proxy "10.0.0.106:8888');
		const t0 = performance.now();
		const { diagnostics } = analyze(broken, schema);
		const ms = performance.now() - t0;
		const err = diagnostics.find((d) => d.source === 'parser' && /quote/i.test(d.message));
		expect(err).toBeDefined();
		const idx = new LineIndex(broken);
		expect(idx.lineOf(err!.from)).toBe(broken.slice(0, broken.indexOf('"10.0.0.106')).split('\n').length);
		expect(err!.to).toBeGreaterThan(err!.from);
		expect(ms).toBeLessThan(150);
	});

	it('puts schema problems on the offending token', () => {
		const text = 'example.com {\n\tredir https://a.example permanently\n\treverse_proxyy 10.0.0.1:80\n}\n';
		const { diagnostics } = analyze(text, schema);
		const bad = diagnostics.find((d) => d.source === 'schema' && d.message.includes('permanently'));
		expect(bad && text.slice(bad.from, bad.to)).toBe('permanently');
		const unknown = diagnostics.find((d) => d.code === 'unknown-directive');
		expect(unknown && text.slice(unknown.from, unknown.to)).toBe('reverse_proxyy');
		expect(unknown?.severity).toBe('warning');
	});

	it('maps an inline matcher definition argument to its token', () => {
		const text = 'example.com {\n\t@x status 2xx 99\n\trespond @x 200\n}\n';
		const { diagnostics } = analyze(text, schema);
		// status is a response matcher; in a site it is unknown, which must land on the module name.
		for (const d of diagnostics.filter((x) => x.source === 'schema')) {
			expect(text.slice(d.from, d.to).length).toBeGreaterThan(0);
			expect(new LineIndex(text).lineOf(d.from)).toBe(2);
		}
	});

	it('works without a schema', () => {
		expect(analyze(SAMPLE, null).diagnostics).toEqual([]);
	});

	it('places Caddy line diagnostics after the indentation', () => {
		const text = 'a.example {\n\treverse_proxy x\n}\n';
		const [d] = placeLineDiagnostics(text, [
			{ severity: 'error', source: 'adapt', message: 'boom', line: 2 }
		]);
		expect(text.slice(d!.from, d!.to)).toBe('reverse_proxy x');
		const [none] = placeLineDiagnostics(text, [{ severity: 'error', source: 'adapt', message: 'boom' }]);
		expect(none!.from).toBe(0);
	});
});

describe('cursor context', () => {
	const scopeAt = (text: string) => resolveScope(schema, openFrames(text));

	it('resolves nested scopes', () => {
		expect(scopeAt('')).toEqual({ kind: 'top' });
		expect(scopeAt('{\n')).toEqual({ kind: 'global' });
		expect(scopeAt('a.example {\n').kind).toBe('directives');
		expect(scopeAt('(snip) {\n')).toEqual({ kind: 'directives', snippet: true });
		expect(scopeAt('a.example {\n\thandle /x {\n').kind).toBe('directives');
		expect(scopeAt('a.example {\n\t@m {\n')).toEqual({ kind: 'matchers' });
		const rp = scopeAt('a.example {\n\treverse_proxy x {\n');
		expect(rp.kind === 'sub' && rp.owner.name).toBe('reverse_proxy');
		const tr = scopeAt('a.example {\n\treverse_proxy x {\n\t\ttransport http {\n');
		expect(tr.kind === 'sub' && Object.keys(tr.owner.subdirectives ?? {})).toContain('tls_server_name');
		const closed = scopeAt('a.example {\n\treverse_proxy x {\n\t}\n');
		expect(closed.kind).toBe('directives');
		const servers = scopeAt('{\n\tservers {\n');
		expect(servers.kind === 'sub' && Object.keys(servers.owner.subdirectives ?? {})).toContain(
			'trusted_proxies'
		);
	});

	it('finds the word and the tokens before it', () => {
		const text = 'a.example {\n\t@api path /x\n\treverse_proxy @a';
		const c = cursorContext(schema, text, text.length);
		expect(c.before).toEqual(['reverse_proxy']);
		expect(c.word).toBe('@a');
		expect(text.slice(c.wordFrom)).toBe('@a');
		expect(c.matcherNames).toEqual(['@api']);
	});

	it('offers what fits the scope', () => {
		const names = (o: { label: string }[]) => o.map((x) => x.label);
		expect(names(lineStartOptions(schema, { kind: 'directives', snippet: false }))).toContain(
			'reverse_proxy'
		);
		expect(names(lineStartOptions(schema, { kind: 'global' }))).toContain('email');
		const rp = schemaFor(schema, { kind: 'directives', snippet: false }, 'reverse_proxy');
		expect(rp?.kind).toBe('directive');
		const redir = schema.directives.redir!;
		expect(names(argumentOptions(redir, 1, { matcherNames: [], acceptsMatcher: true }))).toContain(
			'permanent'
		);
		const first = names(argumentOptions(redir, 0, { matcherNames: ['@api'], acceptsMatcher: true }));
		expect(first).toContain('@api');
		expect(first).toContain('*');
		const transport = schema.directives.reverse_proxy!.subdirectives!.transport!;
		expect(names(argumentOptions(transport, 0, { matcherNames: [], acceptsMatcher: false }))).toEqual(
			expect.arrayContaining(['http', 'fastcgi'])
		);
		const lb = schema.directives.reverse_proxy!.subdirectives!.lb_policy!;
		expect(names(argumentOptions(lb, 0, { matcherNames: [], acceptsMatcher: false }))).toContain(
			'round_robin'
		);
	});

	it('documents concrete placeholders', () => {
		expect(findPlaceholder(schema, '{host}')?.name).toBe('{host}');
		expect(findPlaceholder(schema, '{path.1}')?.name).toBe('{path.N}');
		expect(findPlaceholder(schema, '{re.api.1}')?.name).toBe('{re.name.N}');
		expect(findPlaceholder(schema, '{http.request.header.X-Forwarded-For}')?.name).toBe(
			'{http.request.header.*}'
		);
		expect(findPlaceholder(schema, '{$APP_ENV}')?.name).toBe('{$VAR}');
		expect(findPlaceholder(schema, '{nope.nope}')).toBeUndefined();
	});
});
