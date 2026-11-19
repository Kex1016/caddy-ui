import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../support/paths.mjs';

// The README screenshots, taken against the demo stack (demo.mjs). Run with
// `pnpm --filter @caddy-ui/e2e screenshots`; see docs/testing.md.

const OUT = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

test.beforeAll(async ({ request }) => {
	// Wait until the probes see the sites behind the stub upstreams.
	await expect
		.poll(
			async () => {
				const { sites } = (await (await request.get('/api/sites')).json()) as { sites: { status: string }[] };
				return sites.filter((s) => s.status === 'up').length;
			},
			{ timeout: 60_000, intervals: [1000] }
		)
		.toBeGreaterThan(20);
	// And until a metrics scrape has landed, for Caddy's uptime and the per-site charts.
	await expect
		.poll(
			async () => {
				const o = (await (await request.get('/api/overview')).json()) as {
					tiles: { caddyStartedAt: { value: number | null } };
				};
				return o.tiles.caddyStartedAt.value;
			},
			{ timeout: 60_000, intervals: [1000] }
		)
		.not.toBeNull();
});

// The page scrolls inside its own panel, so a taller shot needs a taller window, set before navigating.
async function shot(page: Page, name: string) {
	await page.waitForLoadState('networkidle');
	// Let the charts finish their first draw.
	await page.waitForTimeout(800);
	await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

for (const scheme of ['light', 'dark'] as const) {
	test.describe(scheme, () => {
		test.use({ colorScheme: scheme });
		const suffix = scheme === 'dark' ? '-dark' : '';

		test('overview', async ({ page }) => {
			await page.setViewportSize({ width: 1440, height: 1140 });
			await page.goto('/');
			await expect(page.getByRole('heading', { level: 1 })).toContainText('Overview');
			await shot(page, `overview${suffix}`);
		});

		test('sites', async ({ page }) => {
			await page.goto('/sites');
			await expect(page.getByRole('heading', { level: 1 })).toContainText('Sites');
			await shot(page, `sites${suffix}`);
		});

		test('site', async ({ page }) => {
			await page.setViewportSize({ width: 1440, height: 1290 });
			await page.goto('/sites');
			await page.getByRole('link', { name: 'example.com', exact: true }).first().click();
			await expect(page.getByRole('heading', { level: 1 })).toContainText('example.com');
			await shot(page, `site${suffix}`);
		});

		test('editor, visual', async ({ page }) => {
			await page.goto('/editor');
			await page
				.getByRole('treeitem', { name: /forward_auth/ })
				.first()
				.click();
			await page.evaluate(() => window.scrollTo(0, 0));
			await shot(page, `editor-visual${suffix}`);
		});

		test('editor, split', async ({ page }) => {
			await page.setViewportSize({ width: 1680, height: 1000 });
			await page.goto('/editor');
			await page.getByRole('button', { name: 'Split' }).click();
			await page
				.getByRole('treeitem', { name: /reverse_proxy.*10\.0\.0\.101:8888/ })
				.first()
				.click();
			await page.evaluate(() => window.scrollTo(0, 0));
			await shot(page, `editor-split${suffix}`);
		});

		// The Domains area, against the fake Porkbun the stack starts (seeded from fixtures/seed.json).
		test('domains', async ({ page }) => {
			await page.setViewportSize({ width: 1440, height: 1000 });
			await page.goto('/domains');
			await expect(page.getByRole('heading', { level: 1 })).toHaveText('Domains');
			await shot(page, `domains${suffix}`);
		});

		test('domain DNS', async ({ page }) => {
			await page.setViewportSize({ width: 1440, height: 1240 });
			await page.goto('/domains/example.com/dns');
			await expect(page.getByRole('heading', { level: 2, name: 'DNS records' })).toBeVisible();
			await shot(page, `domain-dns${suffix}`);
		});

		test('domain Caddy', async ({ page }) => {
			await page.setViewportSize({ width: 1440, height: 1100 });
			await page.goto('/domains/example.com/caddy');
			await expect(page.getByRole('heading', { level: 2, name: 'Caddy' })).toBeVisible();
			await shot(page, `domain-caddy${suffix}`);
		});

		test('editor, text', async ({ page }) => {
			await page.goto('/editor?mode=text');
			await expect(page.locator('.cm-content')).toBeVisible();
			// Scroll to the busiest site block (matchers, handle, route) rather than the global options.
			const block = page.locator('.cm-line', { hasText: 'example.com, www.example.com {' });
			await page.mouse.move(800, 700);
			for (let i = 0; i < 20 && !(await block.isVisible()); i++) await page.mouse.wheel(0, 300);
			await block.evaluate((el) => el.scrollIntoView({ block: 'start' }));
			await page.mouse.wheel(0, -60);
			await shot(page, `editor-text${suffix}`);
		});
	});
}
