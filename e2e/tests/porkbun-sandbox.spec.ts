import { expect, test } from '@playwright/test';
import { watchConsole } from '../support/helpers';

// Against Porkbun's sandbox (docs/porkbun-plan.md §5, P7): the optional CI job "Porkbun sandbox" runs this file
// alone, with E2E_PORKBUN=sandbox and a pk1_sb_ key from the repository secrets. Sandbox keys touch nothing
// real. Every other run skips it. It only reads, so it never leaves anything behind in the sandbox account.
test.skip(process.env.E2E_PORKBUN !== 'sandbox', 'needs E2E_PORKBUN=sandbox and a Porkbun sandbox key');

test('the sandbox key connects and the Domains area reads it', async ({ page, request }) => {
	const status = (await (await request.get('/api/porkbun/status?force')).json()) as {
		state: string;
		sandbox: boolean;
		scopes: string[];
	};
	expect(status.state, JSON.stringify(status)).toBe('ok');
	expect(status.sandbox).toBe(true);

	const clean = watchConsole(page);
	await page.goto('/domains');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Domains');
	await expect(page.getByText('Sandbox').first()).toBeVisible();
	const first = page.getByRole('table', { name: 'Domains in the Porkbun account' }).getByRole('link').first();
	if ((await first.count()) === 0) return; // an empty sandbox account: the status check above is the test
	const name = (await first.textContent())!.trim();
	await first.click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
	await page.getByRole('link', { name: 'DNS', exact: true }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'DNS records' })).toBeVisible();
	clean();
});
