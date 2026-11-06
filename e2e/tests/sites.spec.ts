import { expect, test, type Page } from '@playwright/test';
import { applyViaApi, e2eCaddyfile, readDisk, runningConfig, watchConsole } from '../support/helpers';

// PLAN.md §5.1 W8 in a real browser: add, duplicate, disable, enable and delete each go through the parser and
// the config service, and the real Caddy ends up serving (or not serving) the site.

const hosts = async () => JSON.stringify(await runningConfig());
const dialog = (page: Page) => page.getByRole('dialog');

test('add, duplicate, disable, enable and delete a site', async ({ page, request }) => {
	const clean = watchConsole(page);
	await applyViaApi(request, e2eCaddyfile());
	await page.goto('/sites');

	// Add, from the reverse proxy recipe.
	await page.getByRole('button', { name: 'Add site' }).click();
	await dialog(page).getByLabel('Address').fill('test.example.com');
	await dialog(page).getByText('Reverse proxy', { exact: true }).click();
	await dialog(page)
		.getByLabel(/^Upstream/)
		.fill('10.0.0.10:8080');
	await dialog(page).getByRole('button', { name: 'Add site' }).click();
	await expect(dialog(page)).toBeHidden();
	await expect(page.getByRole('link', { name: 'Edit test.example.com' })).toBeVisible();
	expect(readDisk()).toMatch(/\ntest\.example\.com \{\n\treverse_proxy 10\.0\.0\.10:8080\n\}\n/);
	expect(await hosts()).toContain('test.example.com');

	// Duplicate.
	await page.getByRole('button', { name: 'Duplicate test.example.com' }).click();
	await dialog(page).getByLabel('New address').fill('test2.example.com');
	await dialog(page).getByRole('button', { name: 'Duplicate' }).click();
	await expect(dialog(page)).toBeHidden();
	expect(readDisk()).toMatch(/\ntest2\.example\.com \{\n\treverse_proxy 10\.0\.0\.10:8080\n\}\n/);
	expect(await hosts()).toContain('test2.example.com');

	// Disable comments the block out; Caddy stops serving it.
	await page.getByRole('button', { name: 'Disable test2.example.com' }).click();
	await expect(page.getByRole('button', { name: 'Enable test2.example.com' })).toBeVisible();
	expect(readDisk()).toMatch(/# test2\.example\.com \{/);
	expect(await hosts()).not.toContain('test2.example.com');

	// Enable restores it exactly.
	await page.getByRole('button', { name: 'Enable test2.example.com' }).click();
	await expect(page.getByRole('button', { name: 'Disable test2.example.com' })).toBeVisible();
	expect(readDisk()).toMatch(/\ntest2\.example\.com \{\n\treverse_proxy 10\.0\.0\.10:8080\n\}\n/);
	expect(await hosts()).toContain('test2.example.com');

	// Delete both.
	for (const host of ['test2.example.com', 'test.example.com']) {
		await page.getByRole('button', { name: `Delete ${host}` }).click();
		await dialog(page).getByRole('button', { name: 'Delete site' }).click();
		await expect(dialog(page)).toBeHidden();
		await expect(page.getByRole('link', { name: `Edit ${host}` })).toHaveCount(0);
	}
	expect(readDisk()).not.toContain('test.example.com');
	expect(await hosts()).not.toContain('test.example.com');
	clean();
});

test('an outside edit made while the page was open gives a conflict, not an overwrite', async ({
	page,
	request
}) => {
	await applyViaApi(request, e2eCaddyfile());
	await page.goto('/sites');
	// Someone else saves in the meantime.
	const other = e2eCaddyfile().replace('tw.example.net', 'tw2.example.net');
	await applyViaApi(request, other);
	await page.getByRole('button', { name: 'Delete yt.example.net' }).click();
	await dialog(page).getByRole('button', { name: 'Delete site' }).click();
	await expect(dialog(page).getByText(/reload/i)).toBeVisible();
	expect(readDisk()).toContain('yt.example.net');
	expect(readDisk()).toContain('tw2.example.net');
});
