/**
 * Extract every ```caddy and ```caddy-d code block from the Caddy docs into
 * fixtures/docs/, with a manifest. Re-run with:
 *
 *   pnpm fixtures:docs                # fetch from GitHub (raw.githubusercontent.com)
 *   pnpm fixtures:docs <dir>          # read a local checkout of caddyserver/website src/docs/markdown
 *
 * `caddy` blocks are whole Caddyfiles; `caddy-d` blocks are directive fragments
 * that belong inside a site block.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/caddyserver/website/master/src/docs/markdown';

const DIRECTIVES = [
	'abort',
	'acme_server',
	'basic_auth',
	'bind',
	'encode',
	'error',
	'file_server',
	'forward_auth',
	'fs',
	'handle',
	'handle_errors',
	'handle_path',
	'header',
	'import',
	'intercept',
	'invoke',
	'log',
	'log_append',
	'log_level',
	'log_name',
	'log_skip',
	'map',
	'method',
	'metrics',
	'php_fastcgi',
	'push',
	'redir',
	'request_body',
	'request_header',
	'respond',
	'reverse_proxy',
	'rewrite',
	'root',
	'route',
	'templates',
	'timeouts',
	'tls',
	'tracing',
	'try_files',
	'uri',
	'vars'
];

const PAGES = [
	'caddyfile.md',
	'caddyfile-tutorial.md',
	'getting-started.md',
	'running.md',
	'caddyfile/concepts.md',
	'caddyfile/directives.md',
	'caddyfile/matchers.md',
	'caddyfile/options.md',
	'caddyfile/patterns.md',
	'caddyfile/response-matchers.md',
	'quick-starts/reverse-proxy.md',
	'quick-starts/static-files.md',
	'quick-starts/https.md',
	'quick-starts/caddyfile.md',
	'quick-starts/api.md',
	...DIRECTIVES.map((d) => `caddyfile/directives/${d}.md`)
];

interface Entry {
	file: string;
	page: string;
	index: number;
	lang: 'caddy' | 'caddy-d';
	/** 1-based line of the opening fence in the markdown page. */
	line: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures', 'docs');
const localDir = process.argv[2];

async function load(page: string): Promise<string> {
	if (localDir) return readFile(join(localDir, page), 'utf8');
	const res = await fetch(`${RAW}/${page}`);
	if (!res.ok) throw new Error(`${page}: HTTP ${res.status}`);
	return res.text();
}

async function main(): Promise<void> {
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });
	const manifest: Entry[] = [];
	const fence = /^```(caddy|caddy-d)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
	for (const page of PAGES) {
		const md = await load(page);
		let m: RegExpExecArray | null;
		let index = 0;
		while ((m = fence.exec(md)) !== null) {
			const lang = m[1] as 'caddy' | 'caddy-d';
			const body = m[2]!;
			const line = md.slice(0, m.index).split('\n').length;
			const base = page.replace(/\.md$/, '').replace(/\//g, '__');
			const file = `${base}__${String(index).padStart(2, '0')}.${lang === 'caddy' ? 'caddyfile' : 'caddy-d'}`;
			await writeFile(join(outDir, file), body);
			manifest.push({ file, page, index, lang, line });
			index++;
		}
	}
	await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
	const files = await readdir(outDir);
	console.log(
		`${manifest.length} blocks from ${PAGES.length} pages written to ${relative(process.cwd(), outDir)} (${files.length} files)`
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
