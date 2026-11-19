import { expect, test } from '@playwright/test';
import { applyViaApi, e2eCaddyfile, readDisk, runningConfig, watchConsole } from '../support/helpers';
import { fake, openDomainTab } from '../support/porkbun';

// The Caddy tie-in (docs/porkbun-plan.md §4, P5) end to end. CI runs this file against stock Caddy and against
// Caddy built with caddy-dns/porkbun; CADDY_TEST_PORKBUN_PLUGIN=present says which one is under test, the same
// switch `test:caddy` uses.
const plugin = process.env.CADDY_TEST_PORKBUN_PLUGIN === 'present';
const THIS_SERVER = '203.0.113.10'; // the fake's answer to /ping

test.beforeEach(async ({ request }) => {
	await fake.reset();
	await applyViaApi(request, e2eCaddyfile());
});

test(`the Caddy tab says whether the running Caddy has the plugin (${plugin ? 'plugin' : 'stock'} Caddy)`, async ({
	page
}) => {
	const clean = watchConsole(page);
	await openDomainTab(page, 'example.com', 'caddy', 'Caddy');
	await expect(page.getByText(plugin ? 'In the running Caddy' : 'Not in the running Caddy')).toBeVisible();
	if (!plugin) await expect(page.getByText('xcaddy build --with github.com/caddy-dns/porkbun')).toBeVisible();
	// The cross-check: the apex through its own record, a subdomain through the wildcard.
	const www = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'www.example.com' }) });
	await expect(www.first()).toContainText('Points here');
	await expect(
		page.getByRole('list', { name: 'Records auth.example.com resolves through' }).getByRole('listitem')
	).toContainText(new RegExp(`A \\*\\.example\\.com\\W+${THIS_SERVER.replaceAll('.', '\\.')}`));
	clean();
});

test('a site whose record points elsewhere is fixed from the Sites list, through the review step', async ({
	page
}) => {
	await fake.setRecords('example.com', [
		{ name: '', type: 'A', content: THIS_SERVER, ttl: 600 },
		{ name: 'www', type: 'A', content: '198.51.100.7', ttl: 600 }
	]);
	await page.goto('/sites');
	const row = page.getByRole('row', { name: /www\.example\.com/ });
	await expect(row).toContainText('Points elsewhere');
	expect(await fake.writes()).toEqual([]);

	await row.getByRole('button', { name: 'Point the record at this server for www.example.com' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('198.51.100.7');
	await expect(dialog).toContainText(THIS_SERVER);
	await dialog.getByRole('button', { name: 'Change the record' }).click();
	await expect(dialog).toBeHidden({ timeout: 15_000 });

	const www = (await fake.records('example.com')).filter((r) => r.host === 'www' && r.type === 'A');
	expect(www.map((r) => r.content)).toEqual([THIS_SERVER]);
	await expect(row).toContainText('Points here');
});

test(`a wildcard site gets the Porkbun DNS challenge through the hint (${plugin ? 'plugin' : 'stock'} Caddy)`, async ({
	page,
	request
}) => {
	// auto_https is off in the e2e file, so the site asks for an ACME certificate itself.
	await applyViaApi(
		request,
		`${e2eCaddyfile()}\n*.example.com {\n\ttls e2e@example.com\n\trespond "wildcard"\n}\n`
	);
	await page.goto('/sites');
	const row = page.getByRole('row', { name: /\*\.example\.com/ });
	await expect(row).toContainText('Needs DNS challenge');
	const setUp = row.getByRole('button', { name: /^Use the Porkbun DNS challenge for/ });
	if (!plugin) {
		// Without the plugin the hint says so and offers nothing Caddy would refuse.
		await expect(setUp).toHaveCount(0);
		await page.goto('/domains/example.com/caddy');
		await expect(
			page.getByText('The running Caddy has no Porkbun plugin; build it in first.').first()
		).toBeVisible();
		return;
	}
	await setUp.click();
	const dialog = page.getByRole('dialog', { name: 'Use the Porkbun DNS challenge' });
	await expect(dialog).toContainText('api_key {env.PORKBUN_API_KEY}');
	await dialog.getByRole('button', { name: 'Add to the site' }).click();

	{
		await expect(dialog).toBeHidden({ timeout: 15_000 });
		const disk = readDisk();
		expect(disk).toContain(
			'*.example.com {\n\ttls e2e@example.com {\n\t\tdns porkbun {\n\t\t\tapi_key {env.PORKBUN_API_KEY}\n'
		);
		expect(disk).toContain('api_secret_key {env.PORKBUN_API_SECRET_KEY}');
		// Caddy took it: the running config has the provider, and no key value anywhere.
		const running = JSON.stringify(await runningConfig());
		expect(running).toContain('"name":"porkbun"');
		expect(running).not.toContain('pk1_');
		await expect(row).not.toContainText('Needs DNS challenge');
	}
});
