import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
	applyViaApi,
	e2eCaddyfile,
	expectAccessible,
	paths,
	readDisk,
	runningConfig,
	watchConsole
} from '../support/helpers';

// S3 (docs/settings-and-perf-plan.md §3): Check everything, the Caddy helpers, the storage tools, and the
// monitoring thresholds with per-site probe options. The stack probes every 5 s.

const S3_KEYS = [
	'CADDY_UI_CERT_WARN_DAYS',
	'CADDY_UI_PROBE_TIMEOUT',
	'CADDY_UI_REVISIONS_KEEP',
	'CADDY_UI_BACKUPS_KEEP'
];

async function resetS3(request: APIRequestContext) {
	const res = await request.patch('/api/settings', {
		data: Object.fromEntries(S3_KEYS.map((k) => [k, null]))
	});
	expect(res.ok()).toBe(true);
}

const section = (page: Page, name: string) =>
	page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name }) });

test.beforeAll(async ({ request }) => {
	await applyViaApi(request, e2eCaddyfile());
	await resetS3(request);
});
test.afterAll(async ({ request }) => {
	await resetS3(request);
	await applyViaApi(request, e2eCaddyfile());
});

test.describe('Diagnostics', () => {
	test('Check everything lists each dependency with its state', async ({ page }) => {
		const clean = watchConsole(page);
		await page.goto('/settings');
		const diag = section(page, 'Diagnostics');
		await diag.getByRole('button', { name: 'Check everything' }).click();
		await expect(diag.getByRole('button', { name: 'Check again' })).toBeVisible();
		const check = (id: string) => diag.locator(`[data-check="${id}"]`);
		await expect(check('admin')).toContainText('OK');
		await expect(check('admin')).toContainText('Reachable');
		// The e2e Caddyfile has neither metrics nor an access log.
		await expect(check('metrics')).toContainText('Check');
		// Other specs may have created the log file by now, so only its state is checked here.
		await expect(check('access-log')).toContainText('Check');
		await expect(check('porkbun')).toContainText('Ping answered');
		await expect(check('jobs')).toContainText('Probes');
		await expect(check('paths')).toContainText('CADDYFILE_PATH');
		await expect(check('slow')).toBeVisible();
		await expectAccessible(page, 'Settings with diagnostics');
		clean();
	});
});

test.describe('Caddy helpers', () => {
	test('metrics per host: review the change, apply it, and Caddy runs it', async ({ page }) => {
		await page.goto('/settings');
		const helpers = section(page, 'Caddy helpers');
		await helpers
			.locator('[data-helper="metrics"]')
			.getByRole('button', { name: 'Review the change' })
			.click();
		const dialog = page.getByRole('dialog', { name: 'Turn on metrics per host' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('table', { name: 'Changes to the Caddyfile' })).toContainText('per_host');
		await expectAccessible(page, 'metrics helper review');
		await dialog.getByRole('button', { name: 'Apply and reload Caddy' }).click();
		await expect(helpers.getByText(/applied, and Caddy reloaded/)).toBeVisible();
		expect(readDisk()).toMatch(/metrics \{\n\t\tper_host\n\t\}/);
		const running = JSON.stringify(await runningConfig());
		expect(running).toContain('"per_host":true');

		// A second look finds nothing to change.
		await helpers
			.locator('[data-helper="metrics"]')
			.getByRole('button', { name: 'Review the change' })
			.click();
		await expect(page.getByRole('dialog').getByText('Metrics are already on, per host.')).toBeVisible();
		await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();

		const history = await (await page.request.get('/api/caddyfile/revisions')).json();
		expect(JSON.stringify(history)).toContain('Settings: turn on metrics per host');
	});

	test('JSON access log: every site imports a snippet that writes the file the UI reads', async ({
		page
	}) => {
		await page.goto('/settings');
		const helpers = section(page, 'Caddy helpers');
		await helpers
			.locator('[data-helper="access-log"]')
			.getByRole('button', { name: 'Review the change' })
			.click();
		const dialog = page.getByRole('dialog', { name: 'Turn on the JSON access log' });
		await expect(dialog).toContainText(paths.accessLog);
		await dialog.getByRole('button', { name: 'Apply and reload Caddy' }).click();
		await expect(helpers.getByText(/applied, and Caddy reloaded/)).toBeVisible();
		const disk = readDisk();
		expect(disk).toContain(`(access_log) {\n\tlog {\n\t\toutput file ${paths.accessLog}\n\t\tformat json`);
		const sites = disk.split('\n').filter((l) => /^\S.*\{$/.test(l) && !l.startsWith('(') && l !== '{');
		expect(disk.match(/\timport access_log/g)?.length).toBe(sites.length);
	});
});

test.describe('Data and storage', () => {
	test('prune now and compact run in the background and say what they did', async ({ page }) => {
		await page.goto('/settings');
		const storage = section(page, 'Data and storage');
		await storage.getByRole('button', { name: 'Prune now' }).click();
		await expect(storage.getByText(/Nothing was older than the retention window|Deleted \d/)).toBeVisible();
		await storage.getByRole('button', { name: 'Compact', exact: true }).click();
		await expect(storage.getByText(/The file went from|there was no free space to give back/)).toBeVisible({
			timeout: 30_000
		});
		// Probes go on after compacting.
		const before = (await (await page.request.get('/api/sites')).json()).asOf;
		await expect
			.poll(async () => (await (await page.request.get('/api/sites')).json()).asOf, { timeout: 15_000 })
			.toBeGreaterThan(before);
	});

	test('the backup is a .tar.gz with the database and the Caddyfile', async ({ page }) => {
		await page.goto('/settings');
		const storage = section(page, 'Data and storage');
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			storage.getByRole('link', { name: 'Download backup' }).click()
		]);
		expect(download.suggestedFilename()).toMatch(/^caddy-ui-backup-.*\.tar\.gz$/);
		const tar = gunzipSync(readFileSync(await download.path()));
		const names: string[] = [];
		for (let off = 0; off + 512 <= tar.length;) {
			const name = tar
				.subarray(off, off + 100)
				.toString()
				.replace(/\0.*$/s, '');
			if (!name) break;
			const size = parseInt(tar.subarray(off + 124, off + 136).toString(), 8);
			names.push(name);
			if (name === 'caddy-ui.db')
				expect(tar.subarray(off + 512, off + 528).toString()).toBe('SQLite format 3\0');
			off += 512 + Math.ceil(size / 512) * 512;
		}
		expect(names).toEqual(['caddy-ui.db', 'Caddyfile']);
	});

	test('fewer revisions kept trims History at once', async ({ page }) => {
		await page.goto('/settings');
		const storage = section(page, 'Data and storage');
		await storage.getByLabel('Caddyfile revisions kept').fill('10');
		await storage.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(storage.getByText('Saved. It applies now.')).toBeVisible();
		await expect(storage.locator('p', { hasText: /Kept now:\s+(10|[1-9])\s+revisions?\b/ })).toBeVisible();
		const list = await (await page.request.get('/api/caddyfile/revisions')).json();
		expect((list.revisions ?? list).length).toBeLessThanOrEqual(10);
	});
});

test.describe('Monitoring thresholds', () => {
	test('the certificate warning and probe timeout save like any setting', async ({ page }) => {
		await page.goto('/settings');
		const monitoring = section(page, 'Monitoring');
		await monitoring.getByLabel('Warn about certificates').fill('45');
		await monitoring.getByLabel('Probe timeout').fill('90s');
		await monitoring.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(monitoring.getByText(/CADDY_UI_PROBE_TIMEOUT must be between 1s and 60s/)).toBeVisible();
		await monitoring.getByLabel('Probe timeout').fill('3s');
		await monitoring.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(monitoring.getByText('Saved. They apply now.')).toBeVisible();
		// Overview says what it warns under once the next probe cycle rebuilds it.
		await expect
			.poll(
				async () => {
					await page.goto('/');
					return page.locator('main').textContent();
				},
				{ timeout: 20_000 }
			)
			.toContain('warns under 45 days');
		await resetS3(page.request);
	});

	test('a site can be skipped, probed at another path, and given a status that counts as up', async ({
		page
	}) => {
		await page.goto('/settings');
		const monitoring = section(page, 'Monitoring');
		const row = monitoring.locator('tr[data-site]').first();
		const label = (await row.getAttribute('data-site')) as string;
		await row.getByRole('checkbox').uncheck();
		await row.getByRole('button', { name: /Save/ }).click();
		await expect(row.getByText('Saved')).toBeVisible();
		await expect(
			section(page, 'Recent changes').getByRole('row').filter({ hasText: label }).first()
		).toContainText('as usual → not probed');
		await expect
			.poll(
				async () => {
					const sites = (await (await page.request.get('/api/sites')).json()).sites as {
						label: string;
						status: string;
						probeSkipped: boolean;
					}[];
					const s = sites.find((x) => x.label === label);
					return s && `${s.status} ${s.probeSkipped}`;
				},
				{ timeout: 15_000 }
			)
			.toBe('unknown true');

		// Probe again, at /healthz, with 404 counted as up.
		await page.reload();
		const again = section(page, 'Monitoring').locator(`tr[data-site="${label}"]`);
		await again.getByRole('checkbox').check();
		await again.getByLabel(`Path to probe for ${label}`).fill('healthz');
		await again.getByRole('button', { name: /Save/ }).click();
		await expect(section(page, 'Monitoring').getByText('The path must start with a single /')).toBeVisible();
		await again.getByLabel(`Path to probe for ${label}`).fill('/healthz');
		await again.getByLabel(`Statuses that also count as up for ${label}`).fill('404');
		await again.getByRole('button', { name: /Save/ }).click();
		await expect(again.getByText('Saved')).toBeVisible();
		await expect(again).toContainText('/healthz');

		// Back to the defaults.
		await again.getByLabel(`Path to probe for ${label}`).fill('');
		await again.getByLabel(`Statuses that also count as up for ${label}`).fill('');
		await again.getByRole('button', { name: /Save/ }).click();
		await expect(again.getByText('Saved')).toBeVisible();
	});
});
