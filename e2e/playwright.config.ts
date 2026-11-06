import { defineConfig, devices } from '@playwright/test';
import { UI_PORT } from './support/paths.mjs';

const baseURL = `http://127.0.0.1:${UI_PORT}`;

/**
 * The suite runs serially against one stack: the specs share one Caddyfile and one Caddy, and each spec puts the
 * file into the state it needs first (see support/stack.ts helpers). Run with `pnpm --filter @caddy-ui/e2e e2e`
 * after `pnpm build`, with CADDY_BIN or CADDY_ADMIN_URL set (see e2e/README.md).
 */
export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL,
		trace: 'off',
		screenshot: 'only-on-failure'
	},
	projects: [
		{ name: 'setup', testMatch: /auth\.setup\.ts/ },
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1440, height: 900 },
				storageState: '.run/auth.json'
			},
			dependencies: ['setup']
		}
	],
	webServer: {
		command: 'node support/stack.mjs',
		url: `${baseURL}/api/health`,
		reuseExistingServer: false,
		timeout: 60_000,
		stdout: 'pipe',
		stderr: 'pipe'
	}
});
