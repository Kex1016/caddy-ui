import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, watchConsole } from '../support/helpers';

// Display preferences (docs/settings-and-perf-plan.md §3, S6, D20): saved on the server, applied to every page,
// and a browser's own theme or sidebar choice (a cookie) beats the saved default.

const DEFAULTS = {
	range: '24h',
	clock: '24h',
	dateFormat: 'dmy',
	landing: '/',
	theme: 'system',
	sidebar: 'full'
};

const preferences = (page: Page) =>
	page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Preferences' }) });

async function savePrefs(page: Page, values: Partial<typeof DEFAULTS>) {
	await page.goto('/settings');
	const section = preferences(page);
	const labels = {
		range: 'Stats range',
		clock: 'Clock',
		dateFormat: 'Date format',
		landing: 'Landing page',
		theme: 'Theme',
		sidebar: 'Sidebar'
	} as const;
	for (const [key, value] of Object.entries(values)) {
		await section.getByLabel(labels[key as keyof typeof labels]).selectOption(value);
	}
	await section.getByRole('button', { name: 'Save preferences' }).click();
	await expect(section.getByText('Saved. It applies now.')).toBeVisible();
}

test.afterEach(async ({ page }) => {
	await savePrefs(page, DEFAULTS);
	await page.context().clearCookies({ name: 'theme' });
	await page.context().clearCookies({ name: 'sidebar' });
});

test('the clock and date format apply to every page and survive a reload', async ({ page, request }) => {
	const clean = watchConsole(page);
	// Make sure Recent changes has at least one entry to show a time on.
	await request.patch('/api/settings', { data: { CADDY_UI_RETENTION_DAYS: '91' } });
	await request.patch('/api/settings', { data: { CADDY_UI_RETENTION_DAYS: null } });

	await savePrefs(page, { clock: '12h', dateFormat: 'iso' });
	const changes = page.locator('section#changes');
	await expect(changes).toContainText(/\d{4}-\d{2}-\d{2}, \d{1,2}:\d{2} (AM|PM) /);
	await page.reload();
	await expect(changes).toContainText(/\d{4}-\d{2}-\d{2}, \d{1,2}:\d{2} (AM|PM) /);

	await savePrefs(page, { clock: '24h', dateFormat: 'mdy' });
	await expect(changes).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} /);
	clean();
});

test('the default stats range is where Overview and a site open, and a range in the address still wins', async ({
	page
}) => {
	await savePrefs(page, { range: '7d' });
	await page.goto('/');
	const nav = page.getByRole('navigation', { name: 'Time range' });
	await expect(nav.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'true');
	// The default has no parameter; the others spell theirs out.
	await expect(nav.getByRole('link', { name: '7 days' })).not.toHaveAttribute('href', /range=/);
	await expect(nav.getByRole('link', { name: '24 hours' })).toHaveAttribute('href', /range=24h/);
	await page.goto('/?range=1h');
	await expect(nav.getByRole('link', { name: '1 hour' })).toHaveAttribute('aria-current', 'true');
});

test('the landing page opens for a typed address, and Overview stays one click away', async ({ page }) => {
	await savePrefs(page, { landing: '/sites' });
	await page.goto('/');
	await expect(page).toHaveURL(/\/sites$/);
	await page.getByRole('link', { name: 'Overview', exact: true }).first().click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the saved theme and sidebar are the default, and this browser can keep its own', async ({
	page,
	browser
}) => {
	await savePrefs(page, { theme: 'dark', sidebar: 'rail' });

	// A browser with no cookies of its own follows the saved default.
	const fresh = await browser.newContext({ storageState: await page.context().storageState() });
	await fresh.clearCookies({ name: 'theme' });
	await fresh.clearCookies({ name: 'sidebar' });
	const other = await fresh.newPage();
	await other.goto('/about');
	await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
	await expect(other.locator('.fp-shell, body').first()).toBeVisible();

	// Using the theme button here is a per-browser choice that beats the default.
	await other.getByRole('button', { name: /^Theme: dark/ }).click();
	await other.goto('/about');
	await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
	await other.goto('/settings');
	await expect(other.getByText(/This browser keeps its own\s*theme/)).toBeVisible();
	await expectAccessible(other, 'Settings preferences');

	// "Use the saved default here" drops the override.
	await other.getByRole('button', { name: 'Use the saved default here' }).click();
	await expect(other.getByText(/^Done\./)).toBeVisible();
	await other.goto('/about');
	await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
	await fresh.close();
});

test('a bad preference is refused and nothing is saved', async ({ page }) => {
	await page.goto('/settings');
	const res = await page.request.post('/settings?/prefs', {
		form: { clock: '13h' },
		headers: { origin: new URL(page.url()).origin }
	});
	expect(await res.text()).toContain('is not a choice for clock');
	await page.goto('/settings');
	await expect(preferences(page).getByLabel('Clock')).toHaveValue('24h');
});
