// Where the e2e stack keeps its files, and the Caddyfile it starts from. Shared by stack.mjs and the specs.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..');
export const UI_PORT = Number(process.env.E2E_UI_PORT ?? 3101);
const dir = resolve(process.env.E2E_DIR ?? join(here, '..', '.run'));

export const paths = {
	dir,
	caddyfile: join(dir, 'Caddyfile'),
	uiData: join(dir, 'ui-data'),
	caddyData: join(dir, 'caddy-data'),
	accessLog: join(dir, 'access.log'),
	bootConfig: join(dir, 'caddy-boot.json'),
	caddyLog: join(dir, 'caddy.log'),
	uiDir: join(ROOT, 'apps', 'ui'),
	adminUrl: process.env.CADDY_ADMIN_URL ?? 'http://127.0.0.1:2019',
	sample: join(ROOT, 'packages', 'caddy-schema', 'test', 'fixtures', 'sample-home.Caddyfile')
};

/** David's anonymised Caddyfile, byte for byte, as it would sit on his disk (not caddy fmt'ed). */
export function sampleCaddyfile() {
	return readFileSync(paths.sample, 'utf8');
}

/**
 * The same file with three global options added so a real Caddy can load it on a CI runner: no certificate
 * requests for the example domains, and unprivileged ports. Everything else is untouched.
 */
export function e2eCaddyfile(text = sampleCaddyfile()) {
	if (!text.startsWith('{\n')) throw new Error('the sample Caddyfile no longer starts with a global block');
	return text.replace(
		'{\n',
		'{\n        auto_https off\n        http_port 18080\n        https_port 18443\n'
	);
}

export const baseCaddyfile = () => e2eCaddyfile();
