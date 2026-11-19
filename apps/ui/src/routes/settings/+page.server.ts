import { getDb } from '$lib/server/db';
import { config } from '$lib/server/env';
import { getRuntime } from '$lib/server/runtime';
import { getSettings, getStorageMeter, pathChecks, storageFacts } from '$lib/server/settings';
import { checkNow, getUpdates } from '$lib/server/updater';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings (docs/settings-and-perf-plan.md §2.3). Everything the page shows at once comes from memory or a few
 * `stat` calls: the settings view (the same object `GET /api/settings` returns), the path checks and the
 * storage facts. Table sizes need a pass over the whole database, which runs in a worker thread and is
 * streamed in when it is not remembered from the last 15 minutes. Saving goes through `PATCH /api/settings`
 * from the page; the "Test" buttons call `/api/caddy/status` and `/api/porkbun/status?force`.
 */
export const load: PageServerLoad = () => {
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
		/** Two small files in the shared directory: no wait. */
		updates: getUpdates(),
		now: Date.now()
	};
};

export const actions: Actions = {
	/** "Check now": asks the updater through control.json (D13). It answers within one poll. */
	checkNow: async () => {
		try {
			checkNow();
			return { checkRequested: true };
		} catch (err) {
			return fail(500, {
				checkError: `Could not reach the updater: ${err instanceof Error ? err.message : String(err)}`
			});
		}
	},

	/** "Measure again": forget the remembered table sizes and measure now. */
	measure: async () => {
		await getStorageMeter().measure();
		return { measured: true };
	}
};
