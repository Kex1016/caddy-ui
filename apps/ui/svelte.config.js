import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// server.js maps CADDY_UI_PORT to the adapter's PORT before starting the built server.
		adapter: adapter(),
		version: { name: process.env.CADDY_UI_VERSION ?? 'dev' },
		// Origin checking is done in hooks.server.ts by comparing the Origin header's host with the request's
		// host, so the UI works both behind Caddy (https) and on a plain http port without setting an ORIGIN.
		csrf: { trustedOrigins: ['*'] }
	}
};

export default config;
