import { expect, test } from '@playwright/test';
import { watchConsole } from '../support/helpers';
import { fake, openDomainTab } from '../support/porkbun';

// The Domains list, the Overview tab (P1) and the Activity page (P0) against the fake Porkbun.

test.beforeEach(async () => {
	await fake.reset();
});

test('the list filters and searches, and bulk auto-renew reports per domain', async ({ page }) => {
	const clean = watchConsole(page);
	await page.goto('/domains');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Domains');
	const table = page.getByRole('table', { name: 'Domains in the Porkbun account' });
	const rows = table.getByRole('rowgroup').nth(1).getByRole('row');
	await expect(rows).toHaveCount(3);

	await page
		.getByRole('group', { name: 'Filter domains' })
		.getByRole('button', { name: /^Auto-renew off/ })
		.click();
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('example.net');
	await page.getByRole('group', { name: 'Filter domains' }).getByRole('button', { name: /^All/ }).click();
	await page.getByRole('searchbox', { name: 'Search domains and labels' }).fill('homelab');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('example.com');
	await page.getByRole('searchbox', { name: 'Search domains and labels' }).fill('');

	// example.net has it off, example.com on: only one changes.
	await page.getByRole('checkbox', { name: 'Select example.net' }).check();
	await page.getByRole('checkbox', { name: 'Select example.com' }).check();
	await page
		.getByRole('region', { name: 'Selected domains' })
		.getByRole('button', { name: 'Turn auto-renew on' })
		.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('1 selected domain already has it on');
	expect(await fake.writes()).toEqual([]);
	await dialog.getByRole('button', { name: 'Turn on for 1 domain' }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });

	const writes = await fake.writes();
	expect(writes.map((w) => w.path)).toEqual(['domain/updateAutoRenew/example.net']);
	await expect(page.getByRole('row', { name: /example\.net/ })).toContainText('on');
	clean();
});

test('the Overview tab matches Porkbun and turns auto-renew off through review', async ({ page }) => {
	await openDomainTab(page, 'example.com', 'overview', 'At a glance');
	const reg = page.getByRole('region', { name: 'Registration' });
	await expect(reg).toContainText('ACTIVE');
	await expect(reg).toContainText('15 Jan 2027');
	await expect(reg).toContainText('$11.08 a year');
	await expect(page.getByRole('link', { name: /^DNS records 11/ })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Nameservers' })).toContainText('maceio.ns.porkbun.com');

	await reg.getByRole('button', { name: 'Turn off' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
	await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
	await expect(reg).toContainText(/Auto-renew\s*off/);

	// The write is on the Activity page, with what it replaced.
	await page.goto('/domains/activity');
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Activity');
	await expect(page.getByRole('main')).toContainText('example.com');
	await expect(page.getByRole('main')).toContainText(/auto.?renew/i);
});

test('a key without DNS permission disables the editors and says why', async ({ page, request }) => {
	await fake.scopes(['read']);
	// The UI keeps /ping's answer for a few seconds; ask again now.
	expect((await (await request.get('/api/porkbun/status?force')).json()).scopes).not.toContain('dns');
	await openDomainTab(page, 'example.com', 'dns', 'DNS records');
	await expect(page.getByRole('button', { name: 'Add record' })).toBeDisabled();
	await expect(page.getByText(/permission|scope/i).first()).toBeVisible();
	expect(await fake.writes()).toEqual([]);
	await fake.reset();
	await request.get('/api/porkbun/status?force');
});

test('a domain with API access off says what to change at Porkbun', async ({ page }) => {
	await openDomainTab(page, 'example.org', 'overview', 'At a glance');
	await expect(page.getByText('API access is off for this domain.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'porkbun.com' }).first()).toHaveAttribute(
		'href',
		'https://porkbun.com/account/domainsSpeedy'
	);
});

test('a domain that is not in the account is a 404 and never reaches Porkbun', async ({ page, request }) => {
	const res = await request.get('/api/porkbun/domains/not-mine.example/dns');
	expect(res.status()).toBe(404);
	const sent = await fake.requests();
	expect(sent.some((r) => r.path.includes('not-mine.example'))).toBe(false);
	const nav = await page.goto('/domains/not-mine.example');
	expect(nav?.status()).toBe(404);
});
