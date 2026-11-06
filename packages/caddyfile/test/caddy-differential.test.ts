/**
 * Differential tests against a real Caddy binary (W11). Skipped unless CADDY_BIN points at one; CI runs them
 * against the caddy:2.10 image and caddy:2 (latest) in the "caddy-differential" job.
 *
 * For every docs block, the package fixtures and David's anonymised Caddyfile:
 *   1. format(x) is byte-identical to `caddy fmt` of x (the UI writes format() on every save and promises
 *      caddy fmt style), and `caddy fmt` leaves format(x) alone;
 *   2. wherever Caddy can adapt x, it adapts format(x) to the same JSON, so a save never changes what Caddy runs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { format } from '../src/index.js';

const BIN = process.env.CADDY_BIN;
const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const docs = join(fixtures, 'docs');
const sample = fileURLToPath(
	new URL('../../caddy-schema/test/fixtures/sample-home.Caddyfile', import.meta.url)
);

/**
 * Inputs where format() deliberately differs from `caddy fmt`, with the reason. Keep this short; anything
 * else that differs is a formatter bug.
 */
const VERSION = BIN ? execFileSync(BIN, ['version'], { encoding: 'utf8' }).split(' ')[0]! : 'caddy';
const KNOWN: Record<string, string> = {
	// caddy fmt keeps `\` line continuations and breaks the line after them; format() joins the continued line,
	// as the parser reads it. Same tokens, so the adapted config is the same (checked below).
	'edge-cases.caddyfile': 'line continuations',
	// Caddy 2.10's fmt adds a trailing space after a line holding only a `{blocks.*}` placeholder; 2.11 fixed it.
	...(VERSION.startsWith('v2.10.')
		? {
				'docs/caddyfile__directives__import__05.caddyfile': 'caddy 2.10 fmt bug',
				'docs/caddyfile__directives__import__06.caddyfile': 'caddy 2.10 fmt bug'
			}
		: {})
};

const cases: { name: string; text: string }[] = [
	...readdirSync(docs)
		.filter((f) => f.endsWith('.caddyfile'))
		.sort()
		.map((f) => ({ name: `docs/${f}`, text: readFileSync(join(docs, f), 'utf8') })),
	...readdirSync(fixtures)
		.filter((f) => f.endsWith('.caddyfile') && !f.startsWith('invalid-'))
		.sort()
		.map((f) => ({ name: f, text: readFileSync(join(fixtures, f), 'utf8') })),
	{ name: 'sample-home.Caddyfile', text: readFileSync(sample, 'utf8') },
	// Shapes caddy fmt is particular about, found by W11.
	{ name: 'blank lines inside braces', text: 'a {\n\n\trespond hi\n\n\thandle {\n\n\t}\n\n}\n' },
	{ name: 'empty block with a blank line', text: '{$DOMAIN:localhost} {\n\n}\n' },
	{ name: 'trailing spaces in comments', text: 'a {\n  # c  \n\trespond hi   # tail  \n}\n' }
];

function caddyFmt(text: string): string {
	return execFileSync(BIN!, ['fmt', '-'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

const dir = BIN ? mkdtempSync(join(tmpdir(), 'caddy-diff-')) : '';
afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Caddy's JSON for a Caddyfile, or null if Caddy cannot adapt it (a partial docs example, a missing file…). */
function adapt(text: string): unknown {
	const file = join(dir, 'Caddyfile');
	writeFileSync(file, text);
	const r = spawnSync(BIN!, ['adapt', '--config', file, '--adapter', 'caddyfile'], {
		encoding: 'utf8',
		env: { ...process.env, DOMAIN: 'example.com' }
	});
	if (r.status !== 0) return null;
	return JSON.parse(r.stdout);
}

describe.skipIf(!BIN)(`format() against ${VERSION}`, () => {
	it('is byte-identical to caddy fmt on every fixture', () => {
		const wrong: string[] = [];
		for (const c of cases) {
			if (KNOWN[c.name]) continue;
			const ours = format(c.text);
			const theirs = caddyFmt(c.text);
			if (ours !== theirs)
				wrong.push(`${c.name}\n  ours:   ${JSON.stringify(ours)}\n  caddy:  ${JSON.stringify(theirs)}`);
			else if (caddyFmt(ours) !== ours) wrong.push(`${c.name}: caddy fmt changes format()'s output`);
		}
		expect(wrong, wrong.join('\n')).toEqual([]);
	});

	it('never changes what Caddy runs', () => {
		const wrong: string[] = [];
		let adapted = 0;
		for (const c of cases) {
			const before = adapt(c.text);
			if (before === null) continue;
			adapted++;
			const after = adapt(format(c.text));
			try {
				expect(after).toEqual(before);
			} catch {
				wrong.push(c.name);
			}
		}
		expect(wrong, `format() changed the adapted config of: ${wrong.join(', ')}`).toEqual([]);
		// About 220 docs blocks are whole configs Caddy can adapt; if this drops, adapt() is failing for another reason.
		expect(adapted).toBeGreaterThan(150);
	});
});
