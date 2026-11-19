import { expect, test } from '@playwright/test';
import { applyViaApi, e2eCaddyfile, watchConsole } from '../support/helpers';

// docs/settings-and-perf-plan.md §1.3 A and F: Overview and Sites say where their time went (Server-Timing),
// send their shell at once, and stream in what the server has not computed yet, with placeholders until then.

test.beforeAll(async ({ request }) => {
	await applyViaApi(request, e2eCaddyfile());
});

test('Overview, Sites and their APIs send Server-Timing with the steps and the total', async ({
	request
}) => {
	for (const url of ['/', '/sites', '/api/sites', '/api/overview']) {
		const res = await request.get(url);
		expect(res.ok(), url).toBe(true);
		const timing = res.headers()['server-timing'] ?? '';
		expect(timing, url).toMatch(/(^|, )total;dur=[\d.]+$/);
		expect(timing, url).toMatch(/(^|, )states;dur=[\d.]+/);
	}
	const sites = (await request.get('/api/sites')).headers()['server-timing'];
	expect(sites).toMatch(/latestProbes;dur=[\d.]+/);
	expect(sites).toMatch(/snapshot;desc="age \d+ s"/);
});

test('a range the server has not computed yet streams in after the shell, then comes with the page', async ({
	page,
	request
}) => {
	// 30 days: no other spec asks for it, so the server computes it on this request.
	const first = await (await request.get('/?range=30d')).text();
	const placeholder = first.indexOf('aria-busy="true"');
	const streamed = first.indexOf('.resolve(');
	expect(placeholder, 'the shell has placeholders').toBeGreaterThan(-1);
	expect(streamed, 'the data follows in the same response').toBeGreaterThan(placeholder);

	// Within one step of the range it is remembered, so the page has it at once.
	const again = await (await request.get('/?range=30d')).text();
	expect(again).not.toContain('aria-busy="true"');

	// In the browser the placeholders give way to the charts.
	const clean = watchConsole(page);
	await page.goto('/?range=7d');
	await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Requests in flight' })).toBeVisible();
	await expect(page.getByText('Requests', { exact: true }).first()).toBeVisible();
	clean();
});

test('Sites shows its list with statuses from the snapshot', async ({ page }) => {
	const clean = watchConsole(page);
	await page.goto('/sites');
	await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'auth.example.com', exact: true }).first()).toBeVisible();
	clean();
});
