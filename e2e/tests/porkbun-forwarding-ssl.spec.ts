import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { watchConsole } from '../support/helpers';
import { fake, openDomainTab } from '../support/porkbun';

// The Forwarding and SSL tabs (P4) against the fake Porkbun.

test.beforeEach(async () => {
	await fake.reset();
});

test('a URL forward is added, refused a second time, and deleted, each through review', async ({ page }) => {
	const clean = watchConsole(page);
	await openDomainTab(page, 'example.com', 'forwarding', 'URL forwarding');
	await page.getByRole('textbox', { name: 'Subdomain' }).fill('go');
	await page.getByLabel('Send visitors to').fill('https://example.org/landing');
	await page.getByLabel('Type').selectOption({ label: '302 temporary' });
	await page.getByRole('button', { name: 'Review forward' }).click();
	expect(await fake.writes(), 'nothing is sent before the review').toEqual([]);
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('https://example.org/landing');
	await dialog.getByRole('button', { name: 'Add forward' }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });

	const row = page.getByRole('row', { name: /go\.example\.com/ });
	await expect(row).toContainText('https://example.org/landing');
	await expect(row).toContainText('302');

	// Checked here: the refusal below is a 409, which the browser logs as a failed resource.
	clean();

	// The same name again is refused by the server before anything is sent to Porkbun.
	const before = (await fake.writes()).length;
	await page.getByRole('textbox', { name: 'Subdomain' }).fill('go');
	await page.getByLabel('Send visitors to').fill('https://example.net/');
	await page.getByRole('button', { name: 'Review forward' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Add forward' }).click();
	await expect(
		page.getByText(
			'go.example.com already forwards to https://example.org/landing. Delete that forward first.'
		)
	).toBeVisible();
	expect((await fake.writes()).length).toBe(before);
	await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

	await page.getByRole('button', { name: 'Delete the forward from go.example.com' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Delete forward' }).click();
	await expect(page.getByRole('row', { name: /go\.example\.com/ })).toHaveCount(0, { timeout: 15_000 });
});

test.describe('SSL bundle', () => {
	let chain = '';
	test.beforeAll(() => {
		// A throwaway self-signed certificate made for this run, so the tab has something real to parse.
		const dir = mkdtempSync(join(tmpdir(), 'caddy-ui-e2e-ssl-'));
		try {
			execFileSync('openssl', [
				'req',
				'-x509',
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-days',
				'90',
				'-subj',
				'/CN=example.com',
				'-addext',
				'subjectAltName=DNS:example.com,DNS:*.example.com',
				'-keyout',
				join(dir, 'key.pem'),
				'-out',
				join(dir, 'cert.pem')
			]);
			chain = readFileSync(join(dir, 'cert.pem'), 'utf8');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the certificate details show, the chain downloads, and the private key is not served', async ({
		page,
		request
	}) => {
		await fake.sslChain('example.com', chain);
		await openDomainTab(page, 'example.com', 'ssl', 'SSL certificate');
		await expect(page.getByText('example.com', { exact: true }).first()).toBeVisible();
		await expect(page.getByText('*.example.com').first()).toBeVisible();
		await expect(page.getByRole('link', { name: 'Certificate chain (.pem)' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Private key (.pem)' })).toBeDisabled();

		const pem = await request.get('/api/porkbun/domains/example.com/ssl/download?part=chain');
		expect(pem.ok()).toBeTruthy();
		expect(await pem.text()).toContain('BEGIN CERTIFICATE');
		expect(pem.headers()['cache-control']).toContain('no-store');

		const key = await request.get('/api/porkbun/domains/example.com/ssl/download?part=key');
		expect(key.status()).toBe(403);
		expect(await key.text()).not.toContain('PRIVATE KEY');
	});
});
