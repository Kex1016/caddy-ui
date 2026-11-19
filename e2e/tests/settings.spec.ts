import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { watchConsole } from '../support/helpers';
import { paths } from '../support/paths.mjs';
import { fake } from '../support/porkbun';

// The Settings page (docs/settings-and-perf-plan.md §2.3, S2): a section saves on its own, the value in force says
// where it comes from, "Use the environment's value" removes a saved one, every change is in Recent changes,
// and the checks and test buttons answer. The stack sets CADDY_UI_PROBE_INTERVAL=5s and TZ=Europe/Budapest.

const EDITABLE = [
	'CADDY_UI_PROBE_INTERVAL',
	'CADDY_UI_SCRAPE_INTERVAL',
	'CADDY_UI_RETENTION_DAYS',
	'TZ',
	'CADDY_UI_PUBLIC_URL',
	'CADDY_UI_PORKBUN_READONLY',
	'CADDY_UI_PORKBUN_CACHE_TTL',
	'CADDY_UI_UPDATE_INTERVAL'
];

/** Every spec shares one stack, so nothing saved here may outlive this file. */
async function resetAll(request: APIRequestContext) {
	const res = await request.patch('/api/settings', {
		data: Object.fromEntries(EDITABLE.map((k) => [k, null]))
	});
	expect(res.ok()).toBe(true);
}

const section = (page: Page, name: string) =>
	page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name }) });

test.beforeAll(async ({ request }) => {
	await fake.reset();
	await resetAll(request);
});
test.afterAll(async ({ request }) => resetAll(request));

test('saving a value makes it win over the environment, and the reset brings the environment back', async ({
	page
}) => {
	const clean = watchConsole(page);
	await page.goto('/settings');
	const monitoring = section(page, 'Monitoring');
	const field = monitoring.getByLabel('Probe interval');
	await expect(field).toHaveValue('5s');
	await expect(monitoring.getByText('From the environment').first()).toBeVisible();

	await field.fill('1m');
	await monitoring.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(monitoring.getByText('Saved. It applies now.')).toBeVisible();
	await expect(monitoring.getByText('Saved here')).toBeVisible();
	await expect(monitoring.getByText('The environment has 5s.')).toBeVisible();

	const api = await (await page.request.get('/api/settings')).json();
	const row = api.settings.find((s: { key: string }) => s.key === 'CADDY_UI_PROBE_INTERVAL');
	expect(row).toMatchObject({ value: '1m', source: 'saved', env: '5s' });

	const changes = section(page, 'Recent changes');
	await expect(changes.getByRole('row').filter({ hasText: 'nothing saved → 1m' })).toBeVisible();

	await monitoring.getByRole('button', { name: /Use the environment’s value/ }).click();
	await expect(field).toHaveValue('5s');
	await expect(monitoring.getByText('Saved here')).toHaveCount(0);
	await expect(changes.getByRole('row').filter({ hasText: '1m → nothing saved' })).toBeVisible();
	clean();
});

test('a value that does not pass is refused with the same message as the environment variable', async ({
	page
}) => {
	await page.goto('/settings');
	const monitoring = section(page, 'Monitoring');
	await monitoring.getByLabel('Probe interval').fill('soon');
	await monitoring.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(monitoring.getByText(/CADDY_UI_PROBE_INTERVAL must be a duration such as 30s/)).toBeVisible();
	await expect(monitoring.getByLabel('Probe interval')).toHaveAttribute('aria-invalid', 'true');
	const api = await (await page.request.get('/api/settings')).json();
	expect(api.settings.find((s: { key: string }) => s.key === 'CADDY_UI_PROBE_INTERVAL').saved).toBeNull();
});

test('lowering retention says what will go before it is saved', async ({ page }) => {
	await page.goto('/settings');
	const monitoring = section(page, 'Monitoring');
	await monitoring.getByLabel('Keep probe results and metrics for').fill('1');
	// The stack's database is minutes old, so nothing is old enough to go.
	await expect(monitoring.getByText(/Nothing is older than .* yet/)).toBeVisible();
	await monitoring.getByLabel('Keep probe results and metrics for').fill('90');
	await expect(monitoring.getByText(/Nothing is older than/)).toHaveCount(0);
});

test('a time zone saved in Settings changes how every page shows times', async ({ page }) => {
	await page.goto('/settings');
	const display = section(page, 'Display');
	await display.getByLabel('Time zone').fill('America/New_York');
	await display.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(display.getByText('Saved. It applies now.')).toBeVisible();
	await page.goto('/about');
	await expect(page.locator('footer')).toContainText('Times in America/New_York');
	await page.goto('/settings');
	await section(page, 'Display')
		.getByRole('button', { name: /Use the environment’s value/ })
		.click();
	await expect(section(page, 'Display').getByLabel('Time zone')).toHaveValue('Europe/Budapest');
});

test('the Porkbun switch and cache save together, and the keys are only set or not set', async ({ page }) => {
	await page.goto('/settings');
	const domains = section(page, 'Domains');
	await domains.getByRole('button', { name: 'Read-only' }).click();
	await domains.getByLabel('Porkbun cache').fill('5m');
	await domains.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(domains.getByText('Saved. They apply now.')).toBeVisible();
	await expect(domains.getByRole('button', { name: 'Read-only' })).toHaveAttribute('aria-pressed', 'true');
	const status = await (await page.request.get('/api/porkbun/status')).json();
	expect(status.readonly).toBe(true);

	// Never a key, only whether it is set.
	const keyRow = domains.getByRole('row').filter({ hasText: 'PORKBUN_API_KEY' }).first();
	await expect(keyRow).toContainText('set');
	await expect(page.locator('body')).not.toContainText('pk1_');

	await domains.getByRole('button', { name: 'Test connection' }).click();
	await expect(domains.getByText('Connected')).toBeVisible();
	await resetAll(page.request);
});

test('the admin API test, the path checks and the table sizes answer', async ({ page }) => {
	await page.goto('/settings');
	const connections = section(page, 'Connections');
	await connections.getByRole('button', { name: 'Test', exact: true }).click();
	await expect(connections.getByText('Reachable')).toBeVisible();
	const caddyfile = connections.getByRole('row').filter({ hasText: 'CADDYFILE_PATH' });
	await expect(caddyfile).toContainText('Found, readable and writable.');

	const monitoring = section(page, 'Monitoring');
	await expect(monitoring.getByRole('row').filter({ hasText: 'Probe results' })).toBeVisible();
	await monitoring.getByRole('button', { name: 'Measure again' }).click();
	await expect(monitoring.getByRole('button', { name: 'Measure again' })).toBeEnabled();

	const signIn = section(page, 'Sign-in');
	await expect(signIn).toContainText('Local user and password');
	await expect(signIn.getByRole('row').filter({ hasText: 'CADDY_UI_PASSWORD' })).toContainText('set');
});

test('About keeps the version and points to Settings', async ({ page }) => {
	await page.goto('/about');
	await expect(page.locator('main').getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
		'href',
		'/settings'
	);
	await expect(page.locator('table')).toHaveCount(0);
});

// Updates (S4): the UI and the updater talk through two files in the shared folder. The spec plays the updater:
// it writes status.json, and reads control.json to see what the page asked for. (The real script is covered by
// deploy/updater/test/run.sh.)
const channel = join(paths.uiData, 'updater');
const control = () => JSON.parse(readFileSync(join(channel, 'control.json'), 'utf8'));
const iso = (ms: number) => new Date(ms).toISOString();
function updaterStatus(over: Record<string, unknown> = {}) {
	const now = Date.now();
	writeFileSync(
		join(channel, 'status.json'),
		JSON.stringify({
			version: 1,
			updatedAt: iso(now),
			source: 'ghcr',
			pollSeconds: 5,
			checking: false,
			intervalSeconds: 3600,
			intervalFrom: 'env',
			nextCheckAt: iso(now + 1_800_000),
			checkNowHandled: null,
			warning: null,
			latest: { version: '1.1.0', id: 'sha256:abc' },
			lastRun: {
				startedAt: iso(now - 60_000),
				finishedAt: iso(now - 56_000),
				trigger: 'timer',
				result: 'up-to-date',
				message: 'ghcr.io/example/caddy-ui:latest is the newest image'
			},
			...over
		})
	);
}

test.describe('Updates', () => {
	test.beforeEach(() => {
		rmSync(channel, { recursive: true, force: true });
		mkdirSync(channel, { recursive: true });
	});
	test.afterAll(() => rmSync(channel, { recursive: true, force: true }));

	test('shows what the updater reports, and says so when it has not reported', async ({ page }) => {
		await page.goto('/settings');
		const updates = section(page, 'Updates');
		await expect(updates.getByText('The updater has not reported yet')).toBeVisible();

		updaterStatus();
		await page.reload();
		await expect(updates.getByTestId('update-latest')).toHaveText('1.1.0');
		await expect(updates.getByTestId('update-last')).toContainText('Up to date');
		await expect(updates.getByTestId('update-last')).toContainText('on the timer');
		await expect(updates.getByTestId('update-using')).toContainText('Every 1h');
		await expect(updates.getByText('The updater has not reported yet')).toHaveCount(0);

		updaterStatus({ updatedAt: iso(Date.now() - 600_000) });
		await page.reload();
		await expect(updates.getByText('has not reported for a while')).toBeVisible();
	});

	test('a saved interval reaches control.json, and the reset takes it back', async ({ page }) => {
		const clean = watchConsole(page);
		updaterStatus();
		await page.goto('/settings');
		const updates = section(page, 'Updates');
		await updates.getByLabel('Check for updates every').fill('5m');
		await updates.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(updates.getByText('Saved. It applies now.')).toBeVisible();
		await expect.poll(() => control().interval).toBe('5m');

		await updates.getByRole('button', { name: /Use the default/ }).click();
		await expect.poll(() => control().interval).toBeNull();
		await expect(updates.getByText('uses the default again.')).toBeVisible();
		await expect(updates.getByLabel('Check for updates every')).toHaveValue('1h');

		await updates.getByLabel('Check for updates every').fill('10s');
		await updates.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(updates.locator('#set-caddy_ui_update_interval-err')).toContainText('at least 30s');
		clean();
	});

	test('check now asks once, and the page follows the updater until it has answered', async ({ page }) => {
		updaterStatus();
		await page.goto('/settings');
		const updates = section(page, 'Updates');
		await updates.getByRole('button', { name: 'Check now' }).click();
		await expect(updates.getByText(/Asked\. The updater picks it up/)).toBeVisible();
		await expect.poll(() => control().checkNow).toMatch(/^[0-9a-f]{16}$/);
		const token = control().checkNow as string;

		// The updater picks it up, runs, and reports.
		updaterStatus({ checking: true, checkNowHandled: token, nextCheckAt: null });
		await expect(updates.getByRole('button', { name: 'Checking…' })).toBeDisabled();
		updaterStatus({
			checkNowHandled: token,
			lastRun: {
				startedAt: iso(Date.now() - 4000),
				finishedAt: iso(Date.now()),
				trigger: 'check-now',
				result: 'updated',
				message: 'caddy-ui is healthy on 1.2.0'
			},
			latest: { version: '1.2.0', id: 'sha256:def' }
		});
		await expect(updates.getByTestId('update-last')).toContainText('Updated', { timeout: 15_000 });
		await expect(updates.getByTestId('update-last')).toContainText('by “Check now”');
		await expect(updates.getByRole('button', { name: 'Check now' })).toBeEnabled();
	});
});
