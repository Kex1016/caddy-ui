import { config } from '$lib/server/env';
import { getRuntime } from '$lib/server/runtime';
import { UI_VERSION } from '$lib/server/version';
import { SIDEBAR_COOKIE, parseSidebar } from '$lib/theme';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, cookies }) => {
	const { auth } = getRuntime();
	return {
		identity: locals.identity,
		theme: locals.theme,
		sidebar: parseSidebar(cookies.get(SIDEBAR_COOKIE)),
		authOff: auth.mode === 'local-disabled',
		version: UI_VERSION,
		timeZone: config().timeZone,
		/** CADDY_UI_SETTINGS_IGNORE is on: saved settings are not in force (the Settings page says why). */
		settingsIgnored: config().settingsIgnore
	};
};
