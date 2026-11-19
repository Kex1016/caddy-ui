import { fail } from '@sveltejs/kit';
import { getCollector } from '$lib/server/collector';
import { ProbeOptionsError, parseProbeOptions } from '$lib/server/collector/probe-options';
import { getConfigService } from '$lib/server/config';
import { authorOf } from '$lib/server/config/http';
import { getDb } from '$lib/server/db';
import { config } from '$lib/server/env';
import { getRuntime } from '$lib/server/runtime';
import {
	PrefsRefused,
	SettingsRefused,
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
import {
	SECRET_ROWS,
	TransferRefused,
	applyImport,
	buildExport,
	hasSecrets,
	planImport,
	type TransferDeps
} from '$lib/server/settings/transfer';
import { getNotifier } from '$lib/server/notify';
import { UI_VERSION } from '$lib/server/version';
import { loadProbeOptions } from '$lib/server/collector/probe-options';
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
/** The running server behind the export and import of the Settings page (S6). */
function transferDeps(): TransferDeps {
	const db = getDb();
	return {
		settings: getSettings(),
		prefs: getPrefs(),
		sites: () => getCollector().sites.map((s) => ({ id: s.id, addresses: s.addresses })),
		probeOptions: () => loadProbeOptions(db),
		saveProbeOptions: saveSiteProbeOptions,
		readSecret: (key) =>
			(db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
				?.value ?? null,
		notify: {
			config: () => getNotifier().config,
			update: (patch, author) => void getNotifier().update(patch, author)
		},
		writeSecret: (key, value, author) => {
			if (key === 'notify.webhook') {
				getNotifier().update({ webhook: value }, author);
				return;
			}
			db.prepare(
				'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
			).run(key, value);
		},
		uiVersion: UI_VERSION
	};
}

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
		/** Whether this build stores a secret an export can carry (the checkbox is shown only then). */
		transferSecrets: hasSecrets() ? SECRET_ROWS.map((r) => r.label) : [],
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
	/** Export: the file's text, which the page offers as a download. Secrets only when the box is ticked. */
	export: async ({ request }) => {
		const form = await request.formData();
		const file = buildExport(transferDeps(), { includeSecrets: form.get('secrets') === 'on' });
		const day = file.exportedAt.slice(0, 10);
		return {
			exportFile: { name: `caddy-ui-settings-${day}.json`, text: JSON.stringify(file, null, 2) + '\n' }
		};
	},

	/** Import, step 1: read the file and say what would change. Nothing is written. */
	importPreview: async ({ request }) => {
		const text = String((await request.formData()).get('text') ?? '');
		try {
			return { importText: text, importPlan: planImport(transferDeps(), text) };
		} catch (err) {
			if (err instanceof TransferRefused) return fail(400, { importError: err.message });
			throw err;
		}
	},

	/** Import, step 2: apply the same file. It is planned again first, so a file that fails changes nothing. */
	importApply: async ({ request, locals }) => {
		const text = String((await request.formData()).get('text') ?? '');
		try {
			const plan = applyImport(transferDeps(), text, authorOf(locals));
			return { importDone: plan.changes.length };
		} catch (err) {
			if (err instanceof TransferRefused) return fail(400, { importError: err.message });
			if (err instanceof SettingsRefused) return fail(400, { importError: err.message });
			throw err;
		}
	},

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
