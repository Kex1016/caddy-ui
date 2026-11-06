import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { paths } from './paths.mjs';

export { paths };
export { e2eCaddyfile, sampleCaddyfile } from './paths.mjs';

type Doc = { text: string; hash: string; drift?: unknown };

/** The file as the UI sees it. */
export async function getDoc(request: APIRequestContext): Promise<Doc> {
	const res = await request.get('/api/caddyfile');
	expect(res.ok(), await res.text()).toBeTruthy();
	return (await res.json()) as Doc;
}

/** Apply a Caddyfile through the UI's own API, as a save from the editor would (so it lands caddy fmt'ed). */
export async function applyViaApi(
	request: APIRequestContext,
	text: string
): Promise<{ text: string; hash: string }> {
	const { hash } = await getDoc(request);
	const res = await request.put('/api/caddyfile', { data: { text, baseHash: hash, note: 'e2e reset' } });
	const body = await res.text();
	expect(res.ok(), body).toBeTruthy();
	return JSON.parse(body) as { text: string; hash: string };
}

/** Raw call to Caddy's admin API with node:http (no browser headers, so Caddy 2.11's origin check passes). */
export function caddyAdmin(method: string, path: string, body?: string, contentType = 'application/json') {
	const url = new URL(path, paths.adminUrl);
	return new Promise<{ status: number; text: string }>((resolve, reject) => {
		const req = http.request(
			url,
			{
				method,
				headers: body ? { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } : {}
			},
			(res) => {
				let text = '';
				res.on('data', (c) => (text += c));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
			}
		);
		req.on('error', reject);
		req.end(body);
	});
}

/** Caddy's JSON for a Caddyfile, from the real Caddy under test. */
export async function adapt(text: string): Promise<unknown> {
	const r = await caddyAdmin('POST', '/adapt', text, 'text/caddyfile');
	expect(r.status, r.text).toBe(200);
	return (JSON.parse(r.text) as { result: unknown }).result;
}

/** Caddy's running config. */
export async function runningConfig(): Promise<unknown> {
	const r = await caddyAdmin('GET', '/config/');
	expect(r.status, r.text).toBe(200);
	return JSON.parse(r.text);
}

export const readDisk = () => readFileSync(paths.caddyfile, 'utf8');

/**
 * Put a file on disk exactly as given (not formatted), as if David had edited it by hand, and load it into Caddy
 * so there is no drift. Then wait until the UI has picked it up (its watcher polls every 2 s).
 */
export async function putOnDisk(request: APIRequestContext, text: string): Promise<Doc> {
	const loaded = await caddyAdmin('POST', '/load', text, 'text/caddyfile');
	expect(loaded.status, loaded.text).toBe(200);
	writeFileSync(paths.caddyfile, text);
	let doc: Doc | undefined;
	await expect
		.poll(async () => (doc = await getDoc(request)).text, { timeout: 15_000, intervals: [250, 500, 1000] })
		.toBe(text);
	return doc as Doc;
}

/** Fail the test on any console error or uncaught page error. Call before navigating. */
export function watchConsole(page: Page): () => void {
	const problems: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
	});
	page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
	return () => expect(problems, problems.join('\n')).toEqual([]);
}

/** axe-core WCAG 2.1 A/AA scan; fails on any serious or critical violation (PLAN.md §5.1 W11). */
export async function expectAccessible(page: Page, what: string) {
	const result = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		// CodeMirror's scroller holds a contenteditable that takes focus and scrolls it; axe does not count
		// contenteditable as focusable content (scrollable-region-focusable false positive).
		.exclude('.cm-scroller')
		.analyze();
	const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	const report = bad
		.map(
			(v) =>
				`${v.impact} ${v.id}: ${v.help}\n${v.nodes
					.slice(0, 5)
					.map((n) => `    ${n.target.join(' ')} — ${n.failureSummary?.split('\n').slice(1).join('; ')}`)
					.join('\n')}`
		)
		.join('\n');
	expect(bad, `${what}: axe found serious violations\n${report}`).toEqual([]);
}

/** Wait for the visual editor to be ready (outline rendered, directive docs loaded). */
export async function openEditor(page: Page, url = '/editor') {
	await page.goto(url);
	await expect(page.getByRole('tree').first()).toBeVisible();
	await expect(page.getByText('loading directive docs…')).toHaveCount(0);
}

/** The whole text in the CodeMirror editor (the DOM only holds the lines on screen). */
export async function editorText(page: Page): Promise<string> {
	// EditorView.findFromDOM, inlined: CodeMirror ≥ 6.40 keeps its tile tree on `cmTile` (older: `cmView`).
	return page.locator('.cm-content').evaluate((el) => {
		type Tile = { root?: { view?: { state: { doc: { toString(): string } } } } };
		const host = el as unknown as { cmTile?: Tile; cmView?: Tile };
		const view = (host.cmTile ?? host.cmView)?.root?.view;
		if (!view) throw new Error('no CodeMirror view on .cm-content');
		return view.state.doc.toString();
	});
}
