import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	server: { port: 5173 },
	test: {
		include: ['src/**/*.test.ts'],
		// No unit test may reach the real Porkbun API (docs/porkbun-plan.md §5.1).
		setupFiles: ['src/lib/server/porkbun/no-network.setup.ts'],
		environment: 'node'
	}
});
