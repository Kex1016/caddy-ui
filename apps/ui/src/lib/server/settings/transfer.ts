import type { EditableSetting } from '$lib/api/settings';
import { DISPLAY_KEYS, DISPLAY_LABELS, DISPLAY_NAMES, isDisplayChoice, type DisplayKey } from '$lib/display';
import type { TransferChange, TransferFile, TransferPlan } from '$lib/settings/types';
import { NO_OPTIONS, parsePath, parseStatuses, type ProbeOptions } from '../collector/probe-options';
import { ConfigError, checkSetting, isEditable } from '../env';
import type { Prefs } from './prefs';
import type { SettingsService } from './service';

/**
 * Export and import of the Settings page (docs/settings-and-perf-plan.md §3, S6). One JSON file with every saved
 * setting, the display preferences, the per-site probe options and, when asked for, the stored secrets.
 * Import is a merge: it sets what the file holds and leaves everything else alone. It first makes a plan, which
 * the page shows, and applies it only on a second request. A file from a newer format is refused.
 */

export const TRANSFER_FORMAT = 'caddy-ui-settings';
export const TRANSFER_VERSION = 1;
/** A settings file is a few kilobytes; anything near this is not one. */
export const MAX_TRANSFER_BYTES = 1_000_000;

/**
 * Rows of the `settings` table that hold a secret the UI stored itself (the Discord webhook URL, D19). They are
 * left out of an export unless asked for, never shown, and imported only when the file carries them. Notification
 * workstreams add theirs here.
 */
export const SECRET_ROWS: { key: string; label: string }[] = [];

/** Whether this build stores any secret an export could carry. */
export const hasSecrets = () => SECRET_ROWS.length > 0;

export type Site = { id: string; addresses: string[] };

/** What the transfer reads and writes, so it can be tested without the running server. */
export type TransferDeps = {
	settings: SettingsService;
	prefs: Prefs;
	/** Sites the collector knows, by id; probe options for any other id are left out of the plan. */
	sites: () => Site[];
	probeOptions: () => Map<string, ProbeOptions>;
	saveProbeOptions: (siteId: string, options: ProbeOptions, author: string) => boolean;
	readSecret: (key: string) => string | null;
	writeSecret: (key: string, value: string) => void;
	uiVersion: string;
	now?: () => number;
};

export class TransferRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TransferRefused';
	}
}

const isDefault = (o: ProbeOptions) => !o.skip && o.path === null && o.upStatuses.length === 0;

export function buildExport(deps: TransferDeps, opts: { includeSecrets: boolean }): TransferFile {
	const settings: Record<string, string> = {};
	for (const row of deps.settings.view().settings) {
		if (row.editable && (row as EditableSetting).saved !== null)
			settings[row.key] = (row as EditableSetting).saved as string;
	}
	const saved = new Set(deps.prefs.saved());
	const preferences: Partial<Record<DisplayKey, string>> = {};
	for (const key of DISPLAY_KEYS) if (saved.has(key)) preferences[key] = deps.prefs.get()[key];
	const sites = new Map(deps.sites().map((s) => [s.id, s]));
	const probeOptions: TransferFile['probeOptions'] = [];
	for (const [siteId, o] of deps.probeOptions()) {
		if (isDefault(o)) continue;
		probeOptions.push({
			siteId,
			label: sites.get(siteId)?.addresses[0] ?? siteId,
			skip: o.skip,
			path: o.path,
			upStatuses: o.upStatuses
		});
	}
	probeOptions.sort((a, b) => a.label.localeCompare(b.label));
	const file: TransferFile = {
		format: TRANSFER_FORMAT,
		formatVersion: TRANSFER_VERSION,
		uiVersion: deps.uiVersion,
		exportedAt: new Date((deps.now ?? Date.now)()).toISOString(),
		settings,
		preferences,
		probeOptions
	};
	if (opts.includeSecrets) {
		const secrets: Record<string, string> = {};
		for (const { key } of SECRET_ROWS) {
			const v = deps.readSecret(key);
			if (v !== null) secrets[key] = v;
		}
		file.secrets = secrets;
	}
	return file;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse the file's text and check its envelope. Throws `TransferRefused` with a sentence for the page. */
export function parseTransfer(text: string): Record<string, unknown> {
	if (Buffer.byteLength(text) > MAX_TRANSFER_BYTES) {
		throw new TransferRefused('This file is too large to be a settings export.');
	}
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new TransferRefused('This is not a JSON file.');
	}
	if (!isObject(doc) || doc.format !== TRANSFER_FORMAT) {
		throw new TransferRefused('This is not a Caddy UI settings export.');
	}
	const v = doc.formatVersion;
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
		throw new TransferRefused('This export has no valid format version.');
	}
	if (v > TRANSFER_VERSION) {
		throw new TransferRefused(
			`This export comes from a newer Caddy UI (file format ${v}; this one reads up to ${TRANSFER_VERSION}). Update this UI, then import again.`
		);
	}
	return doc;
}

const label = (kind: TransferChange['kind'], key: string): string =>
	kind === 'preference' ? `Preference · ${DISPLAY_NAMES[key as DisplayKey] ?? key}` : key;

const showPref = (key: DisplayKey, v: string | null): string | null =>
	v === null ? null : (DISPLAY_LABELS[key][v] ?? v);

const describe = (o: ProbeOptions): string => {
	if (isDefault(o)) return 'as usual';
	const parts: string[] = [];
	if (o.skip) parts.push('not probed');
	if (o.path) parts.push(`path ${o.path}`);
	if (o.upStatuses.length) parts.push(`also up: ${o.upStatuses.join(', ')}`);
	return parts.join(' · ');
};

/** What importing `text` would change here. Nothing is written. `errors` non-empty means it cannot be applied. */
export function planImport(deps: TransferDeps, text: string): TransferPlan {
	const doc = parseTransfer(text);
	const changes: TransferChange[] = [];
	const errors: string[] = [];
	const notes: string[] = [];
	let same = 0;

	// Saved settings.
	const current = new Map<string, string | null>();
	for (const row of deps.settings.view().settings) {
		if (row.editable) current.set(row.key, (row as EditableSetting).saved);
	}
	const settings = isObject(doc.settings) ? doc.settings : {};
	if (doc.settings !== undefined && !isObject(doc.settings)) errors.push('"settings" must be an object.');
	for (const [key, raw] of Object.entries(settings)) {
		if (!isEditable(key)) {
			notes.push(`${key} is not a setting this UI can change, so it is skipped.`);
			continue;
		}
		if (typeof raw !== 'string') {
			errors.push(`${key}: the value must be text.`);
			continue;
		}
		let value: string;
		try {
			value = checkSetting(key, raw);
		} catch (err) {
			errors.push(`${key}: ${err instanceof ConfigError ? err.message : String(err)}`);
			continue;
		}
		if (key === 'CADDY_UI_PORKBUN_READONLY' && value !== 'true' && !deps.settings.signIn) {
			errors.push(`${key}: turning Porkbun changes on needs a sign-in, which this UI does not have.`);
			continue;
		}
		const before = current.get(key) ?? null;
		if (before === raw) same++;
		else changes.push({ kind: 'setting', key, label: label('setting', key), from: before, to: raw });
	}

	// Display preferences.
	const prefs = isObject(doc.preferences) ? doc.preferences : {};
	if (doc.preferences !== undefined && !isObject(doc.preferences))
		errors.push('"preferences" must be an object.');
	const savedPrefs = new Set(deps.prefs.saved());
	for (const [key, raw] of Object.entries(prefs)) {
		if (!(DISPLAY_KEYS as string[]).includes(key)) {
			notes.push(`Preference ${key} is not known to this UI, so it is skipped.`);
			continue;
		}
		const k = key as DisplayKey;
		if (!isDisplayChoice(k, raw)) {
			errors.push(`Preference ${key}: ${JSON.stringify(raw)} is not one of the choices.`);
			continue;
		}
		const before = savedPrefs.has(k) ? deps.prefs.get()[k] : null;
		if (before === raw) same++;
		else
			changes.push({
				kind: 'preference',
				key,
				label: label('preference', key),
				from: showPref(k, before),
				to: showPref(k, raw as string)
			});
	}

	// Per-site probe options.
	const options = Array.isArray(doc.probeOptions) ? doc.probeOptions : [];
	if (doc.probeOptions !== undefined && !Array.isArray(doc.probeOptions))
		errors.push('"probeOptions" must be a list.');
	const known = new Map(deps.sites().map((s) => [s.id, s]));
	const have = deps.probeOptions();
	for (const item of options) {
		if (!isObject(item) || typeof item.siteId !== 'string') {
			errors.push('A probe option has no site id.');
			continue;
		}
		const name = typeof item.label === 'string' && item.label ? item.label : item.siteId;
		let next: ProbeOptions;
		try {
			next = {
				skip: item.skip === true,
				path: typeof item.path === 'string' ? parsePath(item.path) : null,
				upStatuses: Array.isArray(item.upStatuses) ? parseStatuses(item.upStatuses.join(',')) : []
			};
		} catch (err) {
			errors.push(`Probe options for ${name}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (!known.has(item.siteId)) {
			notes.push(`${name} is not a site on this instance, so its probe options are skipped.`);
			continue;
		}
		const before = describe(have.get(item.siteId) ?? NO_OPTIONS);
		const after = describe(next);
		if (before === after) same++;
		else
			changes.push({
				kind: 'probe',
				key: item.siteId,
				label: `Probe options · ${name}`,
				from: before,
				to: after
			});
	}

	// Secrets: shown by name only, never by value.
	const secrets = isObject(doc.secrets) ? doc.secrets : {};
	for (const [key, raw] of Object.entries(secrets)) {
		const def = SECRET_ROWS.find((s) => s.key === key);
		if (!def) {
			notes.push(`A secret named ${key} is not known to this UI, so it is skipped.`);
			continue;
		}
		if (typeof raw !== 'string' || raw === '') {
			errors.push(`${def.label}: the value must be text.`);
			continue;
		}
		if (deps.readSecret(key) === raw) same++;
		else
			changes.push({
				kind: 'secret',
				key,
				label: def.label,
				from: deps.readSecret(key) === null ? null : 'set',
				to: 'set'
			});
	}

	return {
		uiVersion: typeof doc.uiVersion === 'string' ? doc.uiVersion : null,
		exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : null,
		changes,
		unchanged: same,
		notes,
		errors
	};
}

/** Apply the file after planning it again, so a file that fails its checks changes nothing. */
export function applyImport(deps: TransferDeps, text: string, author: string): TransferPlan {
	const plan = planImport(deps, text);
	if (plan.errors.length > 0) {
		throw new TransferRefused('This file has values that do not pass their checks, so nothing was imported.');
	}
	const doc = parseTransfer(text);
	const settingChanges = plan.changes.filter((c) => c.kind === 'setting');
	if (settingChanges.length > 0) {
		deps.settings.update(Object.fromEntries(settingChanges.map((c) => [c.key, c.to])), author);
	}
	const prefChanges = plan.changes.filter((c) => c.kind === 'preference');
	if (prefChanges.length > 0) {
		const prefs = doc.preferences as Record<string, string>;
		deps.prefs.set(Object.fromEntries(prefChanges.map((c) => [c.key, prefs[c.key] as string])));
	}
	const probeChanges = new Set(plan.changes.filter((c) => c.kind === 'probe').map((c) => c.key));
	for (const item of (doc.probeOptions as Record<string, unknown>[] | undefined) ?? []) {
		if (typeof item.siteId !== 'string' || !probeChanges.has(item.siteId)) continue;
		deps.saveProbeOptions(
			item.siteId,
			{
				skip: item.skip === true,
				path: typeof item.path === 'string' ? parsePath(item.path) : null,
				upStatuses: Array.isArray(item.upStatuses) ? parseStatuses(item.upStatuses.join(',')) : []
			},
			author
		);
	}
	for (const c of plan.changes.filter((c) => c.kind === 'secret')) {
		deps.writeSecret(c.key, (doc.secrets as Record<string, string>)[c.key] as string);
	}
	return plan;
}
