import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	parse,
	parseFragment,
	print,
	printNodes,
	format,
	type Block,
	type Node,
	type Trivia
} from '../src/index.js';

const fixturesDir = new URL('../fixtures/', import.meta.url);
const docsDir = new URL('../fixtures/docs/', import.meta.url);
const sampleUrl = new URL('../../caddy-schema/test/fixtures/sample-home.Caddyfile', import.meta.url);

interface Entry {
	file: string;
	page: string;
	index: number;
	lang: 'caddy' | 'caddy-d';
	line: number;
}

const manifest = JSON.parse(readFileSync(new URL('manifest.json', docsDir), 'utf8')) as Entry[];

/**
 * Docs blocks that are deliberately partial and may legitimately produce raw
 * nodes or diagnostics. Currently none: every block in the Caddy docs parses
 * clean. Add `page#index` here if the docs change.
 */
const PARTIAL = new Set<string>([]);

function countRaw(nodes: readonly Node[]): number {
	let n = 0;
	for (const node of nodes) {
		if (node.kind === 'raw') n++;
		if (node.body) n += countRaw(node.body);
		if (node.kind === 'matcher' && node.inline?.body) n += countRaw(node.inline.body);
	}
	return n;
}

function countRawBlocks(blocks: readonly Block[]): number {
	let n = 0;
	for (const b of blocks) {
		if (b.kind === 'raw') n++;
		else if (b.kind === 'import') n += b.node.body ? countRaw(b.node.body) : 0;
		else n += countRaw(b.body);
	}
	return n;
}

function printTrivia(trivia: Trivia[]): string {
	return trivia.map((t) => (t.indent ?? '') + t.text + (t.newline ?? '')).join('');
}

describe('byte-exact round trip', () => {
	it("David's Caddyfile (anonymised sample)", () => {
		const src = readFileSync(sampleUrl, 'utf8');
		const r = parse(src);
		expect(r.diagnostics).toEqual([]);
		expect(countRawBlocks(r.file.blocks)).toBe(0);
		expect(print(r.file)).toBe(src);
		expect(format(format(src))).toBe(format(src));
	});

	const local = readdirSync(fixturesDir).filter((f) => f.endsWith('.caddyfile'));
	for (const f of local) {
		it(`fixture ${f}`, () => {
			const src = readFileSync(new URL(f, fixturesDir), 'utf8');
			const r = parse(src);
			expect(print(r.file)).toBe(src);
			if (!f.startsWith('invalid-')) {
				expect(r.diagnostics).toEqual([]);
				expect(countRawBlocks(r.file.blocks)).toBe(0);
				expect(format(format(src))).toBe(format(src));
			}
		});
	}
});

describe('every code block in the Caddy docs', () => {
	it('has fixtures', () => {
		expect(manifest.length).toBeGreaterThan(400);
	});

	for (const e of manifest) {
		const key = `${e.page}#${e.index}`;
		it(`${e.lang} ${e.page}:${e.line}`, () => {
			const src = readFileSync(new URL(e.file, docsDir), 'utf8');
			if (e.lang === 'caddy') {
				const r = parse(src);
				expect(print(r.file)).toBe(src);
				if (!PARTIAL.has(key)) {
					expect(r.diagnostics).toEqual([]);
					expect(countRawBlocks(r.file.blocks)).toBe(0);
				}
				const once = format(src);
				expect(format(once)).toBe(once);
			} else {
				const r = parseFragment(src);
				expect(printNodes(r.nodes) + printTrivia(r.trailingTrivia)).toBe(src);
				if (!PARTIAL.has(key)) {
					expect(r.diagnostics).toEqual([]);
					expect(countRaw(r.nodes)).toBe(0);
				}
			}
		});
	}
});
