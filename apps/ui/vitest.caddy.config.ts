import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vite.config';

/** Tests against a real Caddy admin API at CADDY_TEST_ADMIN_URL; CI starts one in the "caddy" job. */
export default mergeConfig(
	base,
	defineConfig({ test: { include: ['src/**/*.caddy-test.ts'], testTimeout: 30_000 } })
);
