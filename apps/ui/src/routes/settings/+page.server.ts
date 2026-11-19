import { fail } from '@sveltejs/kit';
import { getCollector } from '$lib/server/collector';
import { ProbeOptionsError, parseProbeOptions } from '$lib/server/collector/probe-options';
import { getConfigService } from '$lib/server/config';
import { authorOf } from '$lib/server/config/http';
import { getDb } from '$lib/server/db';
import { config } from '$lib/server/env';
import { getNotifier } from '$lib/server/notify';
import { getRuntime } from '$lib/server/runtime';
import {
	PrefsRefused,
	getPrefs,
	getSettings,
	getStorageMeter,
	pathChecks,
	storageFacts
} from '$lib/server/settings';
import { MaintenanceRefused } from '$lib/server/settings/maintenance';
import {
	checkEverything,
	getMaintenance,
	helperProposal,
	probeOptionRows,
	saveSiteProbeOptions
} from '$lib/server/settings/tools';
import type { HelperId } from '$lib/settings/types';
import { DISPLAY_KEYS, type DisplayKey } from '$lib/display';
import { SIDEBAR_COOKIE, THEME_COOKIE } from '$lib/theme';
import { checkNow, getUpdates } from '$lib/server/updater';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings (docs/settings-and-perf-plan.md §2.3 and §3). Everything the page shows at once comes from memory or a
 * few `stat` calls: the settings view (the same object `GET /api/settings` returns), the path checks, the storage
 * facts, the collector's job status and the per-site probe options. Table sizes need a pass over the whole
 * database, which runs in a worker thread and is streamed in when it is not remembered from the last 15 minutes.
 *
 * Saving goes through `PATCH /api/settings` from the page; the "Test" buttons call `/api/caddy/status` and
 * `/api/porkbun/status?force`. The S3 tools are form actions on this page (no new API route, except the backup
 * download): Check everything, the Caddy helpers' proposals (applied with the editor's `PUT /api/caddyfile`),
 * prune now, compact, and per-site probe options.
 */
export const load: PageServerLoad = async ({ depends, cookies }) => {
	depends('settings:tools');
	const cfg = config();
	const db = getDb();
	const { auth } = getRuntime();
	const c = getCollector();
	return {
		view: getSettings().view(),
		authMode: auth.mode,
		paths: pathChecks(cfg),
		storage: storageFacts(db, db.name, cfg.uiData),
		/** A promise only while a measurement runs; SvelteKit streams it in after the page's shell. */
		tables: getStorageMeter().current(),
		maintenance: getMaintenance().state(),
		history: await getConfigService()
			.historyCounts()
			.catch((err: unknown) => {
				console.error('caddy-ui: counting the Caddyfile history:', err);
				return null;
			}),
		probeOptions: probeOptionRows(),
		probeTimeoutMs: c.probeTimeout,
		helpers: {
			metrics: {
				read: c.status.metrics.lastOk !== null,
				perHost: c.status.metrics.perHost,
				error: c.status.metrics.error
			},
			accessLog: {
				path: c.status.logs.path,
				found: c.status.logs.found,
				lastEntry: c.status.logs.lastEntry
			}
		},
		/** Discord notifications (S5): never the webhook URL, only whether one is saved. */
		notifications: getNotifier().view(),
		now: Date.now(),
		/** Two small files in the shared directory: no wait. */
		updates: getUpdates(),
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

const HELPERS: readonly HelperId[] = ['metrics', 'access-log'];

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
	},

	/** "Check everything" (Diagnostics). */
	diagnose: async () => ({ report: await checkEverything() }),

	/** A Caddy helper's change for review. Applying it is the editor's `PUT /api/caddyfile`. */
	helper: async ({ request }) => {
		const form = await request.formData();
		const helper = String(form.get('helper') ?? '') as HelperId;
		if (!HELPERS.includes(helper)) return fail(400, { helperError: 'Unknown helper' });
		try {
			return { proposal: await helperProposal(helper) };
		} catch (err) {
			return fail(503, {
				helperError: `The Caddyfile could not be read: ${err instanceof Error ? err.message : String(err)}`
			});
		}
	},

	/** "Prune now": the hourly retention job, started now. The page polls until it is done. */
	prune: async () => {
		void getMaintenance().startPrune();
		return { started: 'prune' as const };
	},

	/** "Compact database": VACUUM in a worker thread, with the collector's writes held. */
	compact: async () => {
		try {
			void getMaintenance()
				.startCompact()
				.catch((err) => console.error('caddy-ui: compacting the database:', err));
			return { started: 'compact' as const };
		} catch (err) {
			if (err instanceof MaintenanceRefused) return fail(409, { compactError: err.message });
			throw err;
		}
	},

	/** Per-site probe options: skip, another path, more statuses that count as up. */
	probeOptions: async ({ request, locals }) => {
		const form = await request.formData();
		const siteId = String(form.get('siteId') ?? '');
		try {
			const options = parseProbeOptions({
				// The checkbox says "Probe"; unticked means skip.
				skip: form.get('probe') === null,
				path: form.get('path') ?? '',
				upStatuses: form.get('upStatuses') ?? ''
			});
			if (!saveSiteProbeOptions(siteId, options, authorOf(locals))) {
				return fail(404, {
					probeError: {
						siteId,
						field: 'siteId',
						message: 'This site is no longer in the Caddyfile. Reload the page.'
					}
				});
			}
			return { probeSaved: siteId };
		} catch (err) {
			if (err instanceof ProbeOptionsError) {
				return fail(400, { probeError: { siteId, field: err.field, message: err.message } });
			}
			throw err;
		}
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
