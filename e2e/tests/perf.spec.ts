import { expect, test, type Page } from '@playwright/test';
import { applyViaApi, e2eCaddyfile } from '../support/helpers';
import { fake } from '../support/porkbun';

// The performance budget PLAN.md §5.1 asks W11 to set (W7's pages must render inside it). Measured on a cold
// load of each page, against David's ~35-site Caddyfile, with the browser cache off. Budgets are about twice what
// a GitHub runner measures today, so they catch regressions (a chart that pulls in a library, an N+1 on the
// server), not noise. docs/testing.md explains the numbers.

type Budget = { url: string; ttfbMs: number; loadMs: number; jsKb: number; totalKb: number };
const BUDGETS: Record<string, Budget> = {
	Overview: { url: '/', ttfbMs: 500, loadMs: 1500, jsKb: 120, totalKb: 600 },
	Sites: { url: '/sites', ttfbMs: 500, loadMs: 1500, jsKb: 120, totalKb: 600 },
	Site: { url: 'SITE', ttfbMs: 500, loadMs: 1500, jsKb: 120, totalKb: 600 },
	Editor: { url: '/editor', ttfbMs: 500, loadMs: 2000, jsKb: 450, totalKb: 1400 },
	History: { url: '/history', ttfbMs: 500, loadMs: 1500, jsKb: 120, totalKb: 600 },
	// The Domains area (Porkbun, P7), against the fake Porkbun. Every page asks Porkbun on the server first
	// (the e2e stack caches nothing), so time to first byte includes those calls; the same budget holds.
	Domains: { url: '/domains', ttfbMs: 500, loadMs: 1500, jsKb: 120, totalKb: 600 },
	'Domain overview': { url: '/domains/example.com', ttfbMs: 500, loadMs: 1500, jsKb: 120, totalKb: 600 },
	'Domain DNS': { url: '/domains/example.com/dns', ttfbMs: 500, loadMs: 1500, jsKb: 150, totalKb: 600 },
	'Domain Caddy': { url: '/domains/example.com/caddy', ttfbMs: 500, loadMs: 1500, jsKb: 120, totalKb: 600 }
};

async function measure(page: Page, url: string) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
	await page.goto(url, { waitUntil: 'load' });
	await page.waitForLoadState('networkidle');
	return page.evaluate(() => {
		const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
		const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
		const kb = (xs: PerformanceResourceTiming[]) =>
			Math.round(xs.reduce((n, r) => n + r.encodedBodySize, 0) / 1024);
		return {
			ttfbMs: Math.round(nav.responseStart - nav.startTime),
			loadMs: Math.round(nav.loadEventEnd - nav.startTime),
			jsKb: kb(res.filter((r) => r.name.endsWith('.js'))),
			totalKb: kb(res) + Math.round(nav.encodedBodySize / 1024)
		};
	});
}

test.beforeAll(async ({ request }) => {
	await applyViaApi(request, e2eCaddyfile());
	await fake.reset();
});

for (const [name, b] of Object.entries(BUDGETS)) {
	test(`${name} loads within budget`, async ({ page }, info) => {
		let url = b.url;
		if (url === 'SITE') {
			await page.goto('/sites');
			url = (await page
				.getByRole('link', { name: 'auth.example.com', exact: true })
				.first()
				.getAttribute('href'))!;
		}
		const m = await measure(page, url);
		info.annotations.push({ type: 'measured', description: JSON.stringify(m) });
		expect.soft(m.ttfbMs, `${name}: time to first byte`).toBeLessThanOrEqual(b.ttfbMs);
		expect.soft(m.loadMs, `${name}: load event`).toBeLessThanOrEqual(b.loadMs);
		expect.soft(m.jsKb, `${name}: JavaScript (KB over the wire)`).toBeLessThanOrEqual(b.jsKb);
		expect.soft(m.totalKb, `${name}: everything (KB over the wire)`).toBeLessThanOrEqual(b.totalKb);
	});
}

test("the editor is usable on David's Caddyfile within 2 s, and a form edit shows within 300 ms", async ({
	page
}) => {
	const start = Date.now();
	await page.goto('/editor');
	await expect(page.getByRole('treeitem', { name: /yt\.example\.net/ })).toBeVisible();
	await expect(page.getByText('loading directive docs…')).toHaveCount(0);
	const ready = Date.now() - start;
	expect(ready, 'editor ready').toBeLessThanOrEqual(2000);

	await page
		.getByRole('treeitem', { name: /reverse_proxy.*10\.0\.0\.101:8888/ })
		.first()
		.click();
	const upstream = page.getByLabel('Upstreams 1');
	await upstream.fill('10.0.0.101:888');
	await expect(page.getByText('unapplied edits')).toBeVisible();
	// One keystroke: mutate the tree, print, re-parse, re-render the outline.
	const t0 = Date.now();
	await upstream.press('9');
	await expect(page.getByRole('treeitem', { name: /reverse_proxy.*10\.0\.0\.101:8889/ })).toBeVisible();
	const keystroke = Date.now() - t0;
	expect(keystroke, 'keystroke to outline').toBeLessThanOrEqual(300);
	test.info().annotations.push({ type: 'measured', description: JSON.stringify({ ready, keystroke }) });
});

// docs/porkbun-plan.md §5.1 P1: the list renders 1,000 domains within the budget.
test('the Domains list with 1,000 domains loads within budget', async ({ page }, info) => {
	await fake.manyDomains(997);
	try {
		const m = await measure(page, '/domains');
		info.annotations.push({ type: 'measured', description: JSON.stringify(m) });
		await expect(page.getByRole('checkbox', { name: 'Select all 1,000 domains shown' })).toBeVisible();
		expect.soft(m.ttfbMs, 'time to first byte').toBeLessThanOrEqual(1000);
		expect.soft(m.loadMs, 'load event').toBeLessThanOrEqual(2000);
		expect.soft(m.jsKb, 'JavaScript (KB over the wire)').toBeLessThanOrEqual(120);
		expect.soft(m.totalKb, 'everything (KB over the wire)').toBeLessThanOrEqual(800);
	} finally {
		await fake.reset();
	}
});
