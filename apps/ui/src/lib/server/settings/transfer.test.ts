import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db';
import type { ProbeOptions } from '../collector/probe-options';
import { defaultConfig, defaultTemplate } from '$lib/notify/templates';
import type { NotifyConfig, NotifyPatch } from '$lib/notify/types';
import { Prefs } from './prefs';
import { SettingsService } from './service';
import {
	SECRET_ROWS,
	TRANSFER_VERSION,
	TransferRefused,
	applyImport,
	buildExport,
	planImport,
	type TransferDeps
} from './transfer';

/** Export and import (S6): a file out of one instance goes into a fresh one, and bad files change nothing. */

const SITES = [
	{ id: 'a1', addresses: ['app.example.com'] },
	{ id: 'b2', addresses: ['status.example.com'] }
];

function instance(env: Record<string, string> = { CADDY_UI_AUTH_MODE: 'forward' }) {
	const db: Db = openDb(':memory:');
	const options = new Map<string, ProbeOptions>();
	let notifyConfig: NotifyConfig = defaultConfig();
	const notifyCalls: NotifyPatch[] = [];
	const deps: TransferDeps = {
		settings: new SettingsService(db, env),
		prefs: new Prefs(db),
		sites: () => SITES,
		probeOptions: () => options,
		saveProbeOptions: (id, o) => {
			if (!SITES.some((s) => s.id === id)) return false;
			options.set(id, o);
			return true;
		},
		readSecret: (key) =>
			(db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
				?.value ?? null,
		writeSecret: (key, value) =>
			void db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value),
		notify: {
			config: () => notifyConfig,
			update: (patch) => {
				notifyCalls.push(patch);
				notifyConfig = {
					downCycles: patch.downCycles ?? notifyConfig.downCycles,
					flapMinutes: patch.flapMinutes ?? notifyConfig.flapMinutes,
					events: { ...notifyConfig.events, ...(patch.events as NotifyConfig['events']) }
				};
			}
		},
		uiVersion: 'v-test',
		now: () => Date.UTC(2026, 10, 19)
	};
	return { db, deps, options, notifyCalls };
}

const text = (f: unknown) => JSON.stringify(f);

describe('export', () => {
	it('holds only what is saved, with the envelope', () => {
		const { deps } = instance();
		deps.settings.update({ CADDY_UI_PROBE_INTERVAL: '1m', TZ: 'Europe/Budapest' }, 'me');
		deps.prefs.set({ clock: '12h' });
		const file = buildExport(deps, { includeSecrets: false });
		expect(file).toMatchObject({
			format: 'caddy-ui-settings',
			formatVersion: TRANSFER_VERSION,
			uiVersion: 'v-test',
			exportedAt: '2026-11-19T00:00:00.000Z',
			settings: { CADDY_UI_PROBE_INTERVAL: '1m', TZ: 'Europe/Budapest' },
			preferences: { clock: '12h' },
			probeOptions: []
		});
		expect(file.secrets).toBeUndefined();
	});

	it('never carries the Porkbun keys, the password or any environment-only value', () => {
		const { deps } = instance({
			CADDY_UI_AUTH_MODE: 'local',
			CADDY_UI_USER: 'admin',
			CADDY_UI_PASSWORD: 'hunter2hunter2',
			PORKBUN_API_KEY: 'pk1_secretkey',
			PORKBUN_API_SECRET_KEY: 'sk1_secretkey'
		});
		deps.settings.update({ CADDY_UI_PORKBUN_CACHE_TTL: '5m' }, 'me');
		const out = JSON.stringify(buildExport(deps, { includeSecrets: true }));
		expect(out).not.toMatch(/hunter2|pk1_|sk1_|PORKBUN_API_KEY|CADDY_UI_PASSWORD/);
	});

	it('lists non-default probe options with the site address', () => {
		const { deps, options } = instance();
		options.set('a1', { skip: false, path: '/health', upStatuses: [503] });
		options.set('b2', { skip: false, path: null, upStatuses: [] });
		expect(buildExport(deps, { includeSecrets: false }).probeOptions).toEqual([
			{ siteId: 'a1', label: 'app.example.com', skip: false, path: '/health', upStatuses: [503] }
		]);
	});
});

describe('import into a fresh instance', () => {
	it('reproduces the exported settings, preferences and probe options', () => {
		const a = instance();
		a.deps.settings.update({ CADDY_UI_RETENTION_DAYS: '45', CADDY_UI_CERT_WARN_DAYS: '21' }, 'me');
		a.deps.prefs.set({ range: '7d', landing: '/sites', dateFormat: 'iso' });
		a.options.set('b2', { skip: true, path: '/up', upStatuses: [401, 503] });
		const file = text(buildExport(a.deps, { includeSecrets: false }));

		const b = instance();
		const plan = planImport(b.deps, file);
		expect(plan.errors).toEqual([]);
		expect(plan.changes.map((c) => c.kind).sort()).toEqual([
			'preference',
			'preference',
			'preference',
			'probe',
			'setting',
			'setting'
		]);
		applyImport(b.deps, file, 'import');

		expect(buildExport(b.deps, { includeSecrets: false })).toMatchObject({
			settings: { CADDY_UI_RETENTION_DAYS: '45', CADDY_UI_CERT_WARN_DAYS: '21' },
			preferences: { range: '7d', landing: '/sites', dateFormat: 'iso' },
			probeOptions: [{ siteId: 'b2', skip: true, path: '/up', upStatuses: [401, 503] }]
		});
		// Importing the same file again changes nothing.
		const again = planImport(b.deps, file);
		expect(again.changes).toEqual([]);
		expect(again.unchanged).toBe(6);
	});

	it('is a merge: what the file does not mention stays', () => {
		const { deps } = instance();
		deps.settings.update({ TZ: 'UTC' }, 'me');
		applyImport(
			deps,
			text({ format: 'caddy-ui-settings', formatVersion: 1, settings: { CADDY_UI_RETENTION_DAYS: '30' } }),
			'x'
		);
		expect(buildExport(deps, { includeSecrets: false }).settings).toEqual({
			TZ: 'UTC',
			CADDY_UI_RETENTION_DAYS: '30'
		});
	});

	it('logs the changes in the settings log under the importer', () => {
		const { deps } = instance();
		applyImport(
			deps,
			text({ format: 'caddy-ui-settings', formatVersion: 1, settings: { TZ: 'UTC' } }),
			'import-author'
		);
		expect(deps.settings.view().log[0]).toMatchObject({
			author: 'import-author',
			key: 'TZ',
			newValue: 'UTC'
		});
	});
});

describe('files that must be refused', () => {
	const env = (extra: Record<string, unknown>) =>
		text({ format: 'caddy-ui-settings', formatVersion: 1, ...extra });

	it('is not JSON, or not ours', () => {
		const { deps } = instance();
		expect(() => planImport(deps, 'nope')).toThrow(/not a JSON file/);
		expect(() => planImport(deps, text({ format: 'other' }))).toThrow(/not a Caddy UI settings export/);
		expect(() => planImport(deps, text([1]))).toThrow(TransferRefused);
	});

	it('comes from a newer version', () => {
		const { deps } = instance();
		expect(() =>
			planImport(deps, text({ format: 'caddy-ui-settings', formatVersion: TRANSFER_VERSION + 1 }))
		).toThrow(/newer Caddy UI/);
	});

	it('is too large', () => {
		const { deps } = instance();
		expect(() => planImport(deps, 'x'.repeat(1_000_001))).toThrow(/too large/);
	});

	it('has a value that fails its check, and then nothing at all is applied', () => {
		const { deps } = instance();
		const file = env({
			settings: { TZ: 'UTC', CADDY_UI_PROBE_INTERVAL: 'soon' },
			preferences: { clock: '13h' },
			probeOptions: [{ siteId: 'a1', path: 'no-slash' }]
		});
		const plan = planImport(deps, file);
		expect(plan.errors).toHaveLength(3);
		expect(() => applyImport(deps, file, 'x')).toThrow(TransferRefused);
		expect(buildExport(deps, { includeSecrets: false }).settings).toEqual({});
	});

	it('turns Porkbun changes on without a sign-in', () => {
		const { deps } = instance({ CADDY_UI_AUTH_MODE: 'none' });
		const plan = planImport(deps, env({ settings: { CADDY_UI_PORKBUN_READONLY: 'false' } }));
		expect(plan.errors[0]).toMatch(/needs a sign-in/);
	});

	it('names a setting that is environment-only, and skips it', () => {
		const { deps } = instance();
		const plan = planImport(
			deps,
			env({ settings: { CADDY_UI_PASSWORD: 'x', PORKBUN_API_KEY: 'k' }, secrets: { nope: 'v' } })
		);
		expect(plan.errors).toEqual([]);
		expect(plan.changes).toEqual([]);
		expect(plan.notes).toHaveLength(3);
	});

	it('skips probe options for a site this instance does not have', () => {
		const { deps } = instance();
		const plan = planImport(
			deps,
			env({ probeOptions: [{ siteId: 'zz', label: 'gone.example.com', skip: true }] })
		);
		expect(plan.changes).toEqual([]);
		expect(plan.notes[0]).toMatch(/gone\.example\.com is not a site/);
	});
});

describe('secrets', () => {
	it('are exported only when asked for, shown only as "set" in the review, and imported when present', () => {
		SECRET_ROWS.push({ key: 'test.secret', label: 'Test secret' });
		try {
			const a = instance();
			a.deps.writeSecret('test.secret', 'https://hooks.example/abc', 'me');
			expect(buildExport(a.deps, { includeSecrets: false }).secrets).toBeUndefined();
			const withSecret = buildExport(a.deps, { includeSecrets: true });
			expect(withSecret.secrets).toEqual({ 'test.secret': 'https://hooks.example/abc' });

			const b = instance();
			const plan = planImport(b.deps, text(withSecret));
			expect(plan.changes).toEqual([
				{ kind: 'secret', key: 'test.secret', label: 'Test secret', from: null, to: 'set' }
			]);
			expect(JSON.stringify(plan)).not.toContain('hooks.example');
			applyImport(b.deps, text(withSecret), 'x');
			expect(b.deps.readSecret('test.secret')).toBe('https://hooks.example/abc');

			// A file without secrets leaves the stored one alone.
			applyImport(b.deps, text(buildExport(a.deps, { includeSecrets: false })), 'x');
			expect(b.deps.readSecret('test.secret')).toBe('https://hooks.example/abc');
		} finally {
			SECRET_ROWS.pop();
		}
	});
});

describe('Discord notifications (S5)', () => {
	const edited = { ...defaultTemplate('site_down'), heading: 'Down: {site}', enabled: false };

	it('exports the thresholds and the messages that differ, and nothing when all is default', () => {
		const a = instance();
		expect(buildExport(a.deps, { includeSecrets: false }).notifications).toBeUndefined();
		a.deps.notify.update({ downCycles: 4, events: { site_down: edited } }, 'me');
		const out = buildExport(a.deps, { includeSecrets: false }).notifications as Record<string, unknown>;
		expect(out).toMatchObject({
			version: 1,
			downCycles: 4,
			events: { site_down: { heading: 'Down: {site}' } }
		});
	});

	it('imports them into a fresh instance through the notifier, once', () => {
		const a = instance();
		a.deps.notify.update({ downCycles: 4, events: { site_down: edited } }, 'me');
		const file = text(buildExport(a.deps, { includeSecrets: false }));

		const b = instance();
		const plan = planImport(b.deps, file);
		expect(plan.errors).toEqual([]);
		expect(plan.changes.map((c) => c.label)).toEqual([
			'Notifications · failed cycles before "down"',
			'Notifications · Site down message'
		]);
		applyImport(b.deps, file, 'import');
		expect(b.notifyCalls).toHaveLength(1);
		expect(b.deps.notify.config().downCycles).toBe(4);
		expect(b.deps.notify.config().events.site_down.heading).toBe('Down: {site}');
		expect(planImport(b.deps, file).changes).toEqual([]);
	});

	it('refuses a template that does not pass its checks', () => {
		const { deps } = instance();
		const bad = { ...edited, accent: 'red' };
		const plan = planImport(
			deps,
			text({
				format: 'caddy-ui-settings',
				formatVersion: 1,
				notifications: { version: 1, downCycles: 99, events: { site_down: bad, nope: {} } }
			})
		);
		expect(plan.errors.length).toBe(3);
	});

	it('carries the webhook only as a secret, and shows it as "set"', () => {
		const a = instance();
		a.deps.writeSecret('notify.webhook', 'https://discord.com/api/webhooks/1/abc', 'me');
		expect(JSON.stringify(buildExport(a.deps, { includeSecrets: false }))).not.toContain('webhooks');
		const withSecret = buildExport(a.deps, { includeSecrets: true });
		expect(withSecret.secrets).toEqual({ 'notify.webhook': 'https://discord.com/api/webhooks/1/abc' });
		const plan = planImport(instance().deps, text(withSecret));
		expect(plan.changes).toEqual([
			{ kind: 'secret', key: 'notify.webhook', label: 'Discord webhook URL', from: null, to: 'set' }
		]);
		expect(JSON.stringify(plan)).not.toContain('webhooks');
	});
});
