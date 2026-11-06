import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { paths, UI_PORT } from '../support/paths.mjs';

const baseURL = `http://127.0.0.1:${UI_PORT}`;

/**
 * Takes the README screenshots (docs/screenshots/) against the demo stack. Not part of the test suite or CI.
 * See docs/testing.md, "Screenshots".
 */
export default defineConfig({
	testDir: '.',
	testMatch: /\.(setup|spec)\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: 'list',
	outputDir: '../test-results/screenshots',
	use: { baseURL, trace: 'off' },
	projects: [
		{ name: 'setup', testMatch: /auth\.setup\.ts/, testDir: '../tests' },
		{
			name: 'screenshots',
			testMatch: /capture\.spec\.ts/,
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1440, height: 900 },
				deviceScaleFactor: 1,
				storageState: join(paths.dir, 'auth.json')
			},
			dependencies: ['setup']
		}
	],
	webServer: {
		command: 'node screenshots/demo.mjs',
		cwd: '..',
		url: `${baseURL}/api/health`,
		reuseExistingServer: true,
		timeout: 120_000,
		stdout: 'pipe',
		stderr: 'pipe'
	}
});
