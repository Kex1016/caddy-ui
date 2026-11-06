import { expect, test } from '@playwright/test';
import { applyViaApi, e2eCaddyfile, expectAccessible, watchConsole } from '../support/helpers';

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
	{ name: 'About', url: '/about', ready: 'About' }
];

test.beforeAll(async ({ request }) => {
	await applyViaApi(request, e2eCaddyfile());
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
