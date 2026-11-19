import { expect, test } from '@playwright/test';
import { applyViaApi, e2eCaddyfile, watchConsole } from '../support/helpers';
import { fake, openDomainTab } from '../support/porkbun';

// The DNS tab (P2) against the fake Porkbun: add, edit and delete through the pending-changes tray, invalid input
// refused before any call, a batch that partly fails, and export → import into an empty zone.

test.beforeAll(async ({ request }) => {
	await applyViaApi(request, e2eCaddyfile());
});

test.beforeEach(async ({ page }) => {
	await fake.reset();
	// The tray lives in sessionStorage; start each test without one.
	await page.addInitScript(() => {
		if (!sessionStorage.getItem('e2e-tray-cleared')) {
			sessionStorage.clear();
			sessionStorage.setItem('e2e-tray-cleared', '1');
		}
	});
});

test('add, edit and delete records through review and apply', async ({ page }) => {
	const clean = watchConsole(page);
	await openDomainTab(page, 'example.com', 'dns', 'DNS records');

	// Add an A record for a new host.
	await page.getByRole('button', { name: 'Add record' }).click();
	await page.locator('#rf-type').selectOption('A');
	await page.locator('#rf-host').fill('e2e');
	await page.locator('#rf-part-address').fill('203.0.113.77');
	await page.locator('#rf-notes').fill('added by e2e');
	await page.getByRole('button', { name: 'Add to pending changes' }).click();

	// Edit the www A record.
	await page.getByRole('button', { name: 'Edit A www.example.com' }).click();
	await page.locator('#rf-part-address').fill('203.0.113.11');
	await page.getByRole('button', { name: /pending changes/ }).click();

	// Delete the TXT on the apex (a single delete: a plain confirm, no typed domain).
	await page.getByRole('button', { name: 'Delete TXT example.com' }).first().click();

	const tray = page.getByRole('complementary', { name: 'Pending changes' });
	await expect(tray).toContainText('3');
	expect(await fake.writes(), 'nothing is sent before the review').toEqual([]);

	await tray.getByRole('button', { name: 'Review and apply…' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('203.0.113.77');
	await expect(dialog).toContainText('203.0.113.11');
	await dialog.getByRole('button', { name: 'Apply 3 changes' }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });

	const live = await fake.records('example.com');
	expect(live.find((r) => r.host === 'e2e' && r.type === 'A')).toMatchObject({
		content: '203.0.113.77',
		notes: 'added by e2e'
	});
	expect(live.find((r) => r.host === 'www' && r.type === 'A')?.content).toBe('203.0.113.11');
	expect(live.filter((r) => r.host === '' && r.type === 'TXT')).toEqual([]);

	// The table shows the new state.
	await expect(page.getByRole('row', { name: /A e2e\.example\.com/ }).first()).toContainText('203.0.113.77');
	clean();
});

test('invalid input is refused before any call to Porkbun', async ({ page }) => {
	await openDomainTab(page, 'example.com', 'dns', 'DNS records');
	await page.getByRole('button', { name: 'Add record' }).click();
	await page.locator('#rf-type').selectOption('A');
	await page.locator('#rf-host').fill('bad');
	await page.locator('#rf-part-address').fill('999.1.1.1');
	await page.getByRole('button', { name: 'Add to pending changes' }).click();
	await expect(page.locator('#rf-part-address')).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByRole('complementary', { name: 'Pending changes' })).toHaveCount(0);
	expect(await fake.writes()).toEqual([]);
});

test('a batch that Porkbun partly refuses says which change failed', async ({ page }) => {
	await openDomainTab(page, 'example.com', 'dns', 'DNS records');
	const adds: [string, string][] = [
		['e2e-one', '203.0.113.81'],
		['e2e-two', '203.0.113.82']
	];
	for (const [host, ip] of adds) {
		await page.getByRole('button', { name: 'Add record' }).click();
		await page.locator('#rf-type').selectOption('A');
		await page.locator('#rf-host').fill(host);
		await page.locator('#rf-part-address').fill(ip);
		await page.getByRole('button', { name: 'Add to pending changes' }).click();
	}
	await page.getByRole('button', { name: 'Review and apply…' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('button', { name: 'Apply 2 changes' })).toBeEnabled();
	// The dry run passed; now leave room for one more record only, so the second create is refused.
	await fake.recordLimit((await fake.records('example.com')).length + 1);
	await dialog.getByRole('button', { name: 'Apply 2 changes' }).click();
	await expect(page.getByText('1 of 2 changes applied.')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText(/e2e-two\.example\.com: Failed\. The zone is at the maximum/)).toBeVisible();
	// What was not applied stays in the tray; what was applied is in the zone.
	await expect(page.getByRole('complementary', { name: 'Pending changes' })).toContainText(
		'1 pending change'
	);
	const hosts = (await fake.records('example.com')).map((r) => r.host);
	expect(hosts).toContain('e2e-one');
	expect(hosts).not.toContain('e2e-two');
});

test('a zone exported and imported into an empty zone has the same records', async ({ page, request }) => {
	await openDomainTab(page, 'example.com', 'dns', 'DNS records');
	const exported = await request.get('/api/porkbun/domains/example.com/dns/export');
	expect(exported.ok(), await exported.text()).toBeTruthy();
	const zoneFile = (await exported.text()).replaceAll('example.com.', 'example.net.');
	const before = (await fake.records('example.com'))
		.filter((r) => !r.host.startsWith('_acme-challenge'))
		.map((r) => `${r.host} ${r.type} ${r.content} ${r.ttl} ${r.prio ?? ''}`)
		.sort();

	await fake.setRecords('example.net', []);
	await openDomainTab(page, 'example.net', 'dns', 'DNS records');
	await page.getByRole('button', { name: 'Import…' }).click();
	await page.getByLabel('Zone file (BIND format) or the JSON this page exports').fill(zoneFile);
	await page.getByRole('button', { name: 'Check against the zone' }).click();
	await page.getByRole('button', { name: /^Review import of \d+ records?…$/ }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('button', { name: 'Import' }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });

	const after = (await fake.records('example.net'))
		.filter((r) => !r.host.startsWith('_acme-challenge'))
		.map(
			(r) =>
				`${r.host} ${r.type} ${r.content.replaceAll('example.net', 'example.com')} ${r.ttl} ${r.prio ?? ''}`
		)
		.sort();
	expect(after).toEqual(before);
});
