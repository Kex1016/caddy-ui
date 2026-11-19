import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

/**
 * The performance budget for Overview and Sites (docs/settings-and-perf-plan.md §1.3 G): seeds 90 days of data
 * for 35 sites and fails when either page's payload takes over 200 ms. Slow to seed, so it is not part of
 * `pnpm test`; CI runs `pnpm --filter @caddy-ui/ui test:perf` in its own job.
 */
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.perf.ts'],
		setupFiles: ['src/lib/server/porkbun/no-network.setup.ts'],
		environment: 'node',
		testTimeout: 120_000,
		hookTimeout: 600_000
	}
});
