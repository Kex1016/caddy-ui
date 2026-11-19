import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Export and import (docs/settings-and-perf-plan.md §3, S6): the file holds what is saved, a review comes before
// anything changes, a file from a newer format is refused, and an import is a merge.

const EDITABLE_TO_CLEAR = [
	'CADDY_UI_RETENTION_DAYS',
	'CADDY_UI_CERT_WARN_DAYS',
	'CADDY_UI_PORKBUN_CACHE_TTL'
];

async function clear(request: APIRequestContext) {
	await request.patch('/api/settings', { data: Object.fromEntries(EDITABLE_TO_CLEAR.map((k) => [k, null])) });
}

const transfer = (page: Page) =>
	page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Export and import' }) });

async function review(page: Page, body: unknown) {
	await page.goto('/settings');
	const t = transfer(page);
	await t.getByLabel('Settings file').setInputFiles({
		name: 'settings.json',
		mimeType: 'application/json',
		buffer: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
	});
	await t.getByRole('button', { name: 'Review changes' }).click();
	return t;
}

test.beforeAll(async ({ request }) => clear(request));
test.afterAll(async ({ request }) => clear(request));

test('an export downloads with the saved settings and no secrets', async ({ page, request }) => {
	await request.patch('/api/settings', { data: { CADDY_UI_RETENTION_DAYS: '45' } });
	await page.goto('/settings');
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		transfer(page).getByRole('button', { name: 'Download settings file' }).click()
	]);
	expect(download.suggestedFilename()).toMatch(/^caddy-ui-settings-\d{4}-\d{2}-\d{2}\.json$/);
	const file = JSON.parse(
		await (await import('node:fs/promises')).readFile((await download.path()) as string, 'utf8')
	);
	expect(file).toMatchObject({
		format: 'caddy-ui-settings',
		formatVersion: 1,
		settings: { CADDY_UI_RETENTION_DAYS: '45' }
	});
	expect(file.secrets).toBeUndefined();
	expect(JSON.stringify(file)).not.toMatch(/PORKBUN_API|PASSWORD|pk1_/);
	await clear(request);
});

test('an import shows what would change, then applies it', async ({ page, request }) => {
	const t = await review(page, {
		format: 'caddy-ui-settings',
		formatVersion: 1,
		settings: { CADDY_UI_CERT_WARN_DAYS: '21' }
	});
	await expect(t.getByRole('row').filter({ hasText: 'CADDY_UI_CERT_WARN_DAYS' })).toContainText('21');
	// Nothing is saved before Apply.
	let api = await (await request.get('/api/settings')).json();
	expect(api.settings.find((s: { key: string }) => s.key === 'CADDY_UI_CERT_WARN_DAYS').saved).toBeNull();

	await t.getByRole('button', { name: 'Apply 1 change' }).click();
	await expect(t.getByText(/Imported\. 1 change applied now\./)).toBeVisible();
	api = await (await request.get('/api/settings')).json();
	expect(api.settings.find((s: { key: string }) => s.key === 'CADDY_UI_CERT_WARN_DAYS').saved).toBe('21');
	await clear(request);
});

test('a file from a newer format, a value that fails and a foreign file are refused', async ({
	page,
	request
}) => {
	let t = await review(page, { format: 'caddy-ui-settings', formatVersion: 99 });
	await expect(t.getByText(/newer Caddy UI/)).toBeVisible();

	t = await review(page, { format: 'something-else' });
	await expect(t.getByText(/not a Caddy UI settings export/)).toBeVisible();

	t = await review(page, 'not json');
	await expect(t.getByText(/not a JSON file/)).toBeVisible();

	t = await review(page, {
		format: 'caddy-ui-settings',
		formatVersion: 1,
		settings: { CADDY_UI_CERT_WARN_DAYS: 'soon' }
	});
	await expect(t.getByText(/CADDY_UI_CERT_WARN_DAYS/).first()).toBeVisible();
	await expect(t.getByRole('button', { name: /^Apply/ })).toHaveCount(0);
	const api = await (await request.get('/api/settings')).json();
	expect(api.settings.find((s: { key: string }) => s.key === 'CADDY_UI_CERT_WARN_DAYS').saved).toBeNull();
});
