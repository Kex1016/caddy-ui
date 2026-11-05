/**
 * Locates a checkout of caddyserver/website for the generator and tests.
 *
 * Order: $CADDY_DOCS_DIR (an existing checkout), else a cached download of the
 * pinned commit under node_modules/.cache/caddy-docs/<sha>. Set $CADDY_DOCS_REF to
 * a branch name (e.g. `master`) to check the latest docs instead of the pin.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SchemaSource } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(here, '..');
export const PIN_FILE = join(PKG_ROOT, 'docs-source.json');

export type Pin = { repo: string; commit: string; committedAt: string };

export function readPin(): Pin {
	return JSON.parse(readFileSync(PIN_FILE, 'utf8')) as Pin;
}

function git(args: string[], cwd?: string): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Returns the docs root and the source it was taken from. */
export function ensureDocs(): { root: string; source: SchemaSource } {
	const pin = readPin();
	const envDir = process.env.CADDY_DOCS_DIR;
	if (envDir) {
		const root = resolve(envDir);
		let commit = pin.commit;
		let committedAt = pin.committedAt;
		try {
			commit = git(['rev-parse', 'HEAD'], root);
			committedAt = git(['log', '-1', '--format=%cI'], root);
		} catch {
			/* not a git checkout; assume it is the pinned commit */
		}
		return { root, source: { repo: pin.repo, commit, committedAt } };
	}
	const ref = process.env.CADDY_DOCS_REF;
	const cacheBase = join(PKG_ROOT, 'node_modules/.cache/caddy-docs');
	const key = ref ? `ref-${ref}` : pin.commit;
	const root = join(cacheBase, key);
	if (!existsSync(join(root, 'src/docs/markdown/caddyfile/directives.md')) || ref) {
		rmSync(root, { recursive: true, force: true });
		mkdirSync(cacheBase, { recursive: true });
		const tmp = `${root}.tmp-${process.pid}`;
		rmSync(tmp, { recursive: true, force: true });
		const url = `https://github.com/${pin.repo}.git`;
		git(['init', '-q', tmp]);
		git(['-C', tmp, 'remote', 'add', 'origin', url]);
		git(['-C', tmp, 'fetch', '-q', '--depth', '1', 'origin', ref ?? pin.commit]);
		git(['-C', tmp, 'checkout', '-q', 'FETCH_HEAD']);
		renameSync(tmp, root);
	}
	const commit = git(['rev-parse', 'HEAD'], root);
	const committedAt = git(['log', '-1', '--format=%cI'], root);
	return { root, source: { repo: pin.repo, commit, committedAt } };
}
