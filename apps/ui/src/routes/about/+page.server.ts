import { config } from '$lib/server/env';
import { getRuntime } from '$lib/server/runtime';
import { UI_VERSION } from '$lib/server/version';
import type { PageServerLoad } from './$types';

/** What this instance runs with. Secrets are reported as set or unset, never shown. */
export const load: PageServerLoad = () => {
	const cfg = config();
	const { auth, startedAt } = getRuntime();
	const set = (v: string | undefined) => (v ? 'set' : 'unset');
	return {
		version: UI_VERSION,
		startedAt,
		rows: [
			{ name: 'CADDY_UI_AUTH_MODE', value: auth.mode },
			{ name: 'CADDY_UI_USER', value: set(cfg.user) },
			{ name: 'CADDY_UI_PASSWORD', value: set(cfg.password) },
			{ name: 'CADDY_UI_SESSION_SECRET', value: cfg.sessionSecret ? 'set' : 'unset (random at boot)' },
			{ name: 'CADDY_ADMIN_URL', value: cfg.adminUrl },
			{ name: 'CADDYFILE_PATH', value: cfg.caddyfilePath },
			{ name: 'CADDY_LOG_PATH', value: cfg.logPath },
			{ name: 'CADDY_DATA_PATH', value: cfg.dataPath },
			{ name: 'CADDY_UI_DATA', value: cfg.uiData },
			{ name: 'CADDY_UI_PUBLIC_URL', value: cfg.publicUrl ?? 'unset' },
			{ name: 'TZ', value: cfg.timeZone }
		]
	};
};
