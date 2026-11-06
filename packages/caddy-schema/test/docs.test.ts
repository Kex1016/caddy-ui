/**
 * Tests against the Caddy docs themselves (pinned commit in docs-source.json).
 * The docs are fetched once into node_modules/.cache, or read from $CADDY_DOCS_DIR.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	schema,
	validateBlocks,
	validateSiteBody,
	type Diagnostic,
	type DirectiveSchema
} from '../src/index.ts';
import { ensureDocs } from '../scripts/docs-source.ts';
import { docsAt, extract, type ExtractResult } from '../scripts/extract.ts';
import { serialize } from '../scripts/serialize.ts';
import { OUT_FILE } from '../scripts/generate.ts';
import { parse, parseDirectives } from './mini-parse.ts';

let result: ExtractResult;

beforeAll(() => {
	const { root, source } = ensureDocs();
	result = extract(docsAt(root), source);
}, 120_000);

describe('generator', () => {
	it('re-running on the pinned docs reproduces schema.json byte for byte', () => {
		expect(serialize(result.bundle) === readFileSync(OUT_FILE, 'utf8')).toBe(true);
	});
});

describe('coverage of the docs', () => {
	it('has every directive listed in caddyfile/directives.md', () => {
		const missing = result.docsIndex.directives.filter((d) => !schema.directives[d]);
		expect(missing).toEqual([]);
		expect(result.docsIndex.directives.length).toBeGreaterThanOrEqual(41);
	});

	it('has every matcher heading in caddyfile/matchers.md', () => {
		expect(result.docsIndex.matcherHeadings.filter((m) => !schema.matchers[m])).toEqual([]);
		expect(result.docsIndex.matcherTokenHeadings.map((h) => h.toLowerCase())).toEqual([
			'wildcard matchers',
			'path matchers',
			'named matchers'
		]);
	});

	it('has every response matcher', () => {
		expect(result.docsIndex.responseMatcherHeadings.filter((m) => !schema.responseMatchers[m])).toEqual([]);
	});

	it('has every option in caddyfile/options.md', () => {
		const o = result.docsIndex.options;
		const g = schema.globalOptions;
		expect(o.top.filter((n) => !g[n])).toEqual([]);
		// Server Options headings are `servers` subdirectives, except `metrics`, which the docs file there but is global.
		expect(o.servers.filter((n) => !g.servers.subdirectives?.[n] && !g[n])).toEqual([]);
		expect(o.pki.filter((n) => !g.pki.subdirectives?.ca.subdirectives?.[n])).toEqual([]);
		expect(o.events.filter((n) => !g.events.subdirectives?.[n])).toEqual([]);
		for (const [parent, kids] of Object.entries(o.nested)) {
			const host =
				parent === 'listener_wrappers'
					? g.servers.subdirectives?.listener_wrappers
					: g.servers.subdirectives?.[parent];
			expect(host, parent).toBeDefined();
			for (const k of kids)
				expect(host?.subdirectives?.[k] ?? host?.variants?.[k], `${parent} > ${k}`).toBeDefined();
		}
		expect(g.filesystem).toBeDefined();
	});
});

/**
 * Every `caddy` example in the directive and matcher docs is a real, valid
 * Caddyfile, so the schema must not report errors on any of them. Warnings are
 * allowed for plugin directives and options the examples use.
 */
describe('docs examples validate', () => {
	const KNOWN: Record<string, RegExp> = {
		// `respond @early_data 425 "Too Early"`: Caddy reads two arguments as <body> <status>, so this docs
		// example sets body "425" with status "Too Early". Reported, not hidden.
		'matcher tls': /respond: status: expected an HTTP status code.*"Too Early"/
	};

	it('produces no errors on the examples in the directive docs', () => {
		const failures: string[] = [];
		const all = [
			...Object.values(schema.directives).map((d) => [d.name, d.examples] as const),
			...Object.values(schema.matchers).map((m) => [`matcher ${m.name}`, m.examples ?? []] as const),
			...globalExamples()
		];
		let checked = 0;
		for (const [owner, examples] of all) {
			for (const ex of examples) {
				if (/^\s*\.\.\.\s*$/m.test(ex)) continue; // elided examples
				checked++;
				const errs = validateExample(owner, ex).filter((d) => d.severity === 'error');
				const unexplained = errs.filter((d) => !(KNOWN[owner]?.test(d.message) ?? false));
				if (unexplained.length) failures.push(`${owner}:\n${ex}\n→ ${fmtAll(unexplained)}`);
			}
		}
		expect(checked).toBeGreaterThan(200);
		expect(failures.join('\n\n')).toBe('');
	});
});

function globalExamples(): (readonly [string, string[]])[] {
	const out: (readonly [string, string[]])[] = [];
	const walk = (n: DirectiveSchema, path: string) => {
		if (n.examples.length) out.push([`option ${path}`, n.examples]);
		for (const [k, v] of Object.entries(n.subdirectives ?? {})) walk(v, `${path} > ${k}`);
		for (const [k, v] of Object.entries(n.variants ?? {})) walk(v, `${path} ~${k}`);
	};
	for (const o of Object.values(schema.globalOptions)) walk(o, o.name);
	return out;
}

/** A `caddy-d` fragment starts with a directive or matcher; anything else is a whole Caddyfile. */
function validateExample(owner: string, ex: string): Diagnostic[] {
	const first =
		ex
			.split('\n')
			.map((l) => l.trim())
			.find((l) => l && !l.startsWith('#')) ?? '';
	const tok = first.split(/\s+/)[0];
	if (owner.startsWith('matcher ') && tok === owner.slice(8))
		return validateSiteBody(schema, parseDirectives(`@example ${first}`));
	if (schema.directives[tok] || tok.startsWith('@') || schema.matchers[tok]) {
		return validateSiteBody(schema, parseDirectives(ex));
	}
	return validateBlocks(schema, parse(ex));
}

function fmtAll(ds: Diagnostic[]) {
	return ds.map((d) => `L${d.line} ${d.path.join('>')}: ${d.message}`).join('; ');
}
