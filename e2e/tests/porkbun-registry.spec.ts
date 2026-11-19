import { expect, test } from '@playwright/test';
import { watchConsole } from '../support/helpers';
import { fake, openDomainTab } from '../support/porkbun';

// The History and Registry tabs (P3) against the fake Porkbun: preflight blocks a nameserver change, a typed
// confirmation guards one that is allowed, glue round-trips, and a restore shows its dry run and can be undone.

test.beforeEach(async () => {
	await fake.reset();
});

test('a nameserver change is refused while preflight reports a blocker', async ({ page }) => {
	// example.net has a DS record at the registry: moving its nameservers would break DNSSEC.
	await openDomainTab(page, 'example.net', 'registry', 'Nameservers');
	await page.getByRole('button', { name: 'Back to Porkbun defaults…' }).click();
	await page.getByRole('button', { name: 'Review change…' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByText('This can not be applied.')).toBeVisible({ timeout: 15_000 });
	await expect(dialog).toContainText(/DNSSEC/);
	await expect(dialog.getByRole('button', { name: 'Change nameservers' })).toBeDisabled();
	expect((await fake.writes()).filter((w) => w.path.startsWith('domain/updateNs'))).toEqual([]);
});

test('an allowed nameserver change needs the domain typed', async ({ page }) => {
	const clean = watchConsole(page);
	await openDomainTab(page, 'example.com', 'registry', 'Nameservers');
	await page.getByRole('button', { name: 'Change nameservers…' }).click();
	await page.getByLabel('New nameservers, one per line').fill('ns1.example-dns.net\nns2.example-dns.net');
	await page.getByRole('button', { name: 'Review change…' }).click();
	const dialog = page.getByRole('dialog');
	const apply = dialog.getByRole('button', { name: 'Change nameservers' });
	await expect(dialog).toContainText('ns1.example-dns.net');
	await expect(apply).toBeDisabled();
	await dialog.getByRole('textbox').last().fill('example.com');
	await expect(apply).toBeEnabled({ timeout: 15_000 });
	await apply.click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	await expect(page.getByText('Nameservers changed at the registry.')).toBeVisible();
	const ns = (await fake.writes()).filter((w) => w.path.startsWith('domain/updateNs'));
	expect(ns).toHaveLength(1);
	expect(ns[0]!.body).toMatchObject({ ns: ['ns1.example-dns.net', 'ns2.example-dns.net'] });
	clean();
});

test('a glue record is added and deleted', async ({ page }) => {
	await openDomainTab(page, 'example.net', 'registry', 'Glue records');
	const glue = page.getByRole('region', { name: 'Glue records' });
	await glue.getByRole('button', { name: 'Add glue record…' }).click();
	await glue.getByRole('textbox').first().fill('ns1');
	await glue.getByLabel('Addresses, IPv4 or IPv6').fill('203.0.113.53');
	await glue.getByRole('button', { name: 'Review…' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
	await expect(glue).toContainText('203.0.113.53');

	await glue.getByRole('button', { name: /^Delete…/ }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('textbox').last().fill('example.net');
	await dialog.getByRole('button', { name: 'Delete' }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	await expect(glue).toContainText('No glue records');
});

test('a restore shows its dry run first and can be undone', async ({ page, request }) => {
	// A DNS change through the UI's API makes a restore point at Porkbun.
	const zone = (await (await request.get('/api/porkbun/domains/example.com/dns')).json()) as {
		data: { records: { id: string; host: string; type: string }[] };
	};
	const www = zone.data.records.find((r) => r.host === 'www' && r.type === 'A')!;
	const del = await request.delete(`/api/porkbun/domains/example.com/dns/${www.id}`);
	expect(del.ok(), await del.text()).toBeTruthy();
	expect((await fake.records('example.com')).some((r) => r.host === 'www')).toBe(false);

	await openDomainTab(page, 'example.com', 'history', 'Restore points');
	await page.getByRole('button', { name: 'Restore…' }).first().click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('www');
	await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });
	expect((await fake.records('example.com')).some((r) => r.host === 'www' && r.type === 'A')).toBe(true);

	// The restore saved the state it replaced; undo goes back to it.
	await page.getByRole('button', { name: 'Undo this restore…' }).click();
	const undo = page.getByRole('dialog');
	await expect(undo.getByRole('button', { name: 'Undo' })).toBeDisabled();
	await undo.getByRole('textbox').last().fill('example.com');
	await undo.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
	expect((await fake.records('example.com')).some((r) => r.host === 'www' && r.type === 'A')).toBe(false);
});
