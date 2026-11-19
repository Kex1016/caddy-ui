import { expect, test } from '@playwright/test';
import { applyViaApi, e2eCaddyfile, expectAccessible, watchConsole } from '../support/helpers';
import { fake } from '../support/porkbun';

// Every page renders without console errors and passes axe (WCAG 2.1 A/AA) with no serious or critical
// violations, in light and dark themes (PLAN.md §5.1 W11).

const PAGES: { name: string; url: string; ready: string | RegExp }[] = [
	{ name: 'Overview', url: '/', ready: 'Overview' },
	{ name: 'Sites', url: '/sites', ready: 'Sites' },
	{ name: 'Site', url: 'SITE', ready: 'auth.example.com' },
	{ name: 'Editor (visual)', url: '/editor', ready: 'Editor' },
	{ name: 'Editor (text)', url: '/editor?mode=text', ready: 'Editor' },
	{ name: 'Globals', url: '/globals', ready: 'Globals' },
	{ name: 'History', url: '/history', ready: 'History' },
	{ name: 'Settings', url: '/settings', ready: 'Settings' },
	{ name: 'About', url: '/about', ready: 'About' },
	// The Domains area (Porkbun, P7), against the fake Porkbun the stack starts.
	{ name: 'Domains', url: '/domains', ready: 'Domains' },
	{ name: 'Domains activity', url: '/domains/activity', ready: 'Activity' },
	{ name: 'Domain overview', url: '/domains/example.com', ready: 'example.com' },
	{ name: 'Domain DNS', url: '/domains/example.com/dns', ready: 'example.com' },
	{ name: 'Domain history', url: '/domains/example.com/history', ready: 'example.com' },
	{ name: 'Domain registry', url: '/domains/example.net/registry', ready: 'example.net' },
	{ name: 'Domain forwarding', url: '/domains/example.com/forwarding', ready: 'example.com' },
	{ name: 'Domain SSL', url: '/domains/example.com/ssl', ready: 'example.com' },
	{ name: 'Domain Caddy', url: '/domains/example.com/caddy', ready: 'example.com' },
	{ name: 'Domain with API access off', url: '/domains/example.org', ready: 'example.org' }
];

test.beforeAll(async ({ request }) => {
	await applyViaApi(request, e2eCaddyfile());
	await fake.reset();
});

for (const scheme of ['light', 'dark'] as const) {
	for (const p of PAGES) {
		test(`${p.name} renders cleanly and passes axe (${scheme})`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: scheme });
			const clean = watchConsole(page);
			let url = p.url;
			if (url === 'SITE') {
				await page.goto('/sites');
				url = (await page
					.getByRole('link', { name: 'auth.example.com', exact: true })
					.first()
					.getAttribute('href'))!;
			}
			await page.goto(url);
			await expect(page.getByRole('heading', { level: 1 })).toContainText(p.ready);
			await page.waitForLoadState('networkidle');
			await expectAccessible(page, p.name);
			clean();
		});
	}
}

test('Sign-in page passes axe', async ({ browser }) => {
	const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await ctx.newPage();
	await page.goto('/login');
	await expectAccessible(page, 'Sign in');
	await ctx.close();
});
