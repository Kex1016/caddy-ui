/**
 * Regenerates src/generated/schema.json from the Caddy docs.
 *
 *   pnpm --filter @caddy-ui/caddy-schema generate          # pinned commit (docs-source.json)
 *   CADDY_DOCS_DIR=../website pnpm … generate               # a local checkout
 *   CADDY_DOCS_REF=master pnpm … generate -- --pin          # move the pin to latest master
 *   pnpm … generate -- --check                              # fail if the output would change
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ensureDocs, PKG_ROOT, PIN_FILE, readPin } from './docs-source.ts';
import { docsAt, extract } from './extract.ts';
import { serialize } from './serialize.ts';

export const OUT_FILE = join(PKG_ROOT, 'src/generated/schema.json');

export function generate(): { json: string; changed: boolean } {
	const { root, source } = ensureDocs();
	const { bundle } = extract(docsAt(root), source);
	const json = serialize(bundle);
	const prev = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
	return { json, changed: prev !== json };
}

function main() {
	const args = process.argv.slice(2);
	const { root, source } = ensureDocs();
	if (args.includes('--pin')) {
		const pin = readPin();
		writeFileSync(
			PIN_FILE,
			JSON.stringify({ ...pin, commit: source.commit, committedAt: source.committedAt }, null, 2) + '\n'
		);
		console.log(`Pinned ${pin.repo} at ${source.commit}`);
	}
	const { bundle } = extract(docsAt(root), source);
	const json = serialize(bundle);
	const prev = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
	if (args.includes('--check')) {
		if (prev !== json) {
			console.error('schema.json is out of date; run `pnpm --filter @caddy-ui/caddy-schema generate`.');
			process.exit(1);
		}
		console.log('schema.json is up to date.');
		return;
	}
	mkdirSync(dirname(OUT_FILE), { recursive: true });
	writeFileSync(OUT_FILE, json);
	const n = (o: object) => Object.keys(o).length;
	console.log(
		`${prev === json ? 'Unchanged' : 'Wrote'} ${OUT_FILE}: ${n(bundle.directives)} directives, ${n(bundle.matchers)} matchers, ` +
			`${n(bundle.globalOptions)} global options, ${bundle.placeholders.length} placeholders (docs ${source.commit.slice(0, 7)})`
	);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
