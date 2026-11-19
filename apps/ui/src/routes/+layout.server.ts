import { config } from '$lib/server/env';
import { getRuntime } from '$lib/server/runtime';
import { getPrefs } from '$lib/server/settings';
import { UI_VERSION } from '$lib/server/version';
import { SIDEBAR_COOKIE, effectiveSidebar } from '$lib/theme';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, cookies }) => {
	const { auth } = getRuntime();
	const display = getPrefs().get();
	return {
		identity: locals.identity,
		theme: locals.theme,
		sidebar: effectiveSidebar(cookies.get(SIDEBAR_COOKIE), () => display.sidebar),
		/** Saved display preferences: clock, date format, default range, landing page (S6). */
		display,
		authOff: auth.mode === 'local-disabled',
		version: UI_VERSION,
		timeZone: config().timeZone,
		/** CADDY_UI_SETTINGS_IGNORE is on: saved settings are not in force (the Settings page says why). */
		settingsIgnored: config().settingsIgnore
	};
};
