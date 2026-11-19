import { getDb } from '$lib/server/db';
import { config } from '$lib/server/env';
import { getRuntime } from '$lib/server/runtime';
import { DISPLAY_KEYS, type DisplayKey } from '$lib/display';
import {
	PrefsRefused,
	getPrefs,
	getSettings,
	getStorageMeter,
	pathChecks,
	storageFacts
} from '$lib/server/settings';
import { SIDEBAR_COOKIE, THEME_COOKIE } from '$lib/theme';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings (docs/settings-and-perf-plan.md §2.3). Everything the page shows at once comes from memory or a few
 * `stat` calls: the settings view (the same object `GET /api/settings` returns), the path checks and the
 * storage facts. Table sizes need a pass over the whole database, which runs in a worker thread and is
 * streamed in when it is not remembered from the last 15 minutes. Saving goes through `PATCH /api/settings`
 * from the page; the "Test" buttons call `/api/caddy/status` and `/api/porkbun/status?force`.
 */
export const load: PageServerLoad = ({ cookies }) => {
	const cfg = config();
	const db = getDb();
	const { auth } = getRuntime();
	return {
		view: getSettings().view(),
		authMode: auth.mode,
		paths: pathChecks(cfg),
		storage: storageFacts(db, db.name, cfg.uiData),
		/** A promise only while a measurement runs; SvelteKit streams it in after the page's shell. */
		tables: getStorageMeter().current(),
		now: Date.now(),
		/** Display preferences (S6) and which of them this browser overrides with a cookie. */
		prefs: {
			saved: getPrefs().saved(),
			overrides: {
				theme: cookies.get(THEME_COOKIE) !== undefined,
				sidebar: cookies.get(SIDEBAR_COOKIE) !== undefined
			}
		}
	};
};

export const actions: Actions = {
	/** "Measure again": forget the remembered table sizes and measure now. */
	measure: async () => {
		await getStorageMeter().measure();
		return { measured: true };
	},

	/** Save the display preferences (S6). An empty value goes back to the default. */
	prefs: async ({ request }) => {
		const form = await request.formData();
		const patch: Partial<Record<DisplayKey, string | null>> = {};
		for (const key of DISPLAY_KEYS) {
			const v = form.get(key);
			if (typeof v === 'string') patch[key] = v === '' ? null : v;
		}
		try {
			getPrefs().set(patch);
		} catch (err) {
			if (err instanceof PrefsRefused) return fail(400, { prefsError: err.message });
			throw err;
		}
		return { prefsSaved: true };
	},

	/** Drop this browser's theme and sidebar cookies so the saved defaults apply here again. */
	clearOverrides: ({ cookies }) => {
		cookies.delete(THEME_COOKIE, { path: '/' });
		cookies.delete(SIDEBAR_COOKIE, { path: '/' });
		return { overridesCleared: true };
	}
};
