import type {
	EditableSetting,
	EnvOnlySetting,
	SettingRow,
	SettingsError,
	SettingsLogEntry,
	SettingsPatch,
	SettingsView
} from '$lib/api/settings';
import { effectiveAuth } from '../auth';
import type { Db } from '../db';
import {
	ConfigError,
	EDITABLE,
	EDITABLE_DEFAULTS,
	checkSetting,
	isEditable,
	loadConfig,
	type Config,
	type EditableKey
} from '../env';

type Env = Record<string, string | undefined>;

/** Saved settings live in the shared `settings` table under this prefix (D7). */
export const KEY_PREFIX = 'cfg.';

const READONLY = 'CADDY_UI_PORKBUN_READONLY';

/** Called after a change with the new and the previous effective config. */
export type SettingsListener = (next: Config, prev: Config, changed: EditableKey[]) => void;

/** A refused change. `status` is the HTTP status the route answers with. */
export class SettingsRefused extends Error {
	constructor(
		readonly status: 400 | 403 | 409,
		readonly body: SettingsError
	) {
		super(body.message);
		this.name = 'SettingsRefused';
	}
}

/**
 * Environment-only variables shown for reference (plan §2.1). `secret` ones are reported only as set or unset;
 * their values never leave the process. `fromConfig` reads the parsed value where there is one, so the page
 * shows what is in force (for example a trailing slash already removed).
 */
type EnvOnlyDef = {
	key: string;
	secret?: true;
	default?: string | null;
	fromConfig?: (c: Config) => string | null;
};

const ENV_ONLY: EnvOnlyDef[] = [
	{ key: 'CADDY_UI_AUTH_MODE', default: 'local', fromConfig: (c) => c.authMode },
	{ key: 'CADDY_UI_USER', secret: true },
	{ key: 'CADDY_UI_PASSWORD', secret: true },
	{ key: 'CADDY_UI_SESSION_SECRET', secret: true },
	{ key: 'CADDY_ADMIN_URL', default: 'http://caddy:2019', fromConfig: (c) => c.adminUrl },
	{ key: 'CADDYFILE_PATH', default: '/etc/caddy/Caddyfile', fromConfig: (c) => c.caddyfilePath },
	{ key: 'CADDY_LOG_PATH', default: '/var/log/caddy/access.log', fromConfig: (c) => c.logPath },
	{ key: 'CADDY_DATA_PATH', default: '/data/caddy', fromConfig: (c) => c.dataPath },
	{ key: 'CADDY_UI_DATA', default: '/etc/caddy-ui', fromConfig: (c) => c.uiData },
	{ key: 'CADDY_UI_PORT', default: '3001', fromConfig: (c) => String(c.port) },
	{ key: 'PORT' },
	{ key: 'HOST' },
	{ key: 'ORIGIN' },
	{ key: 'PORKBUN_API_KEY', secret: true },
	{ key: 'PORKBUN_API_SECRET_KEY', secret: true },
	{
		key: 'PORKBUN_API_URL',
		default: 'https://api.porkbun.com/api/json/v3',
		fromConfig: (c) => c.porkbun.apiUrl
	},
	{
		key: 'CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD',
		default: 'false',
		fromConfig: (c) => String(c.porkbun.sslKeyDownload)
	},
	{ key: 'CADDY_UI_UPDATE_INTERVAL', default: '1h' },
	{ key: 'CADDY_UI_UPDATE_SOURCE', default: 'ghcr', fromConfig: (c) => c.updateSource },
	{ key: 'CADDY_UI_UPDATE_WEBHOOK_PORT', default: null },
	{ key: 'CADDY_UI_SETTINGS_IGNORE', default: 'false', fromConfig: (c) => String(c.settingsIgnore) }
];

const LOG_LIMIT = 50;

const envValue = (env: Env, key: string): string | null => {
	const v = env[key]?.trim();
	return v ? v : null;
};

/** Accept what a JSON body can carry for a setting: a string, or a number or boolean turned into one. */
function asText(key: string, v: unknown): string | null {
	if (v === null) return null;
	if (typeof v === 'string') return v;
	if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	if (typeof v === 'boolean') return String(v);
	throw new SettingsRefused(400, {
		message: `${key} must be a string, or null to use the environment's value`,
		code: 'INVALID',
		errors: { [key]: 'must be a string, or null to use the environment’s value' }
	});
}

/**
 * The settings service (plan §2.2). Saved values override the environment, which overrides the defaults
 * (D16). A saved value that no longer passes its check is ignored with a warning, never fatal (D11). With
 * `CADDY_UI_SETTINGS_IGNORE=true` nothing saved is used (D17). The read-only switch for Porkbun may be
 * turned off only while the UI has a sign-in (D9), and a saved "off" is ignored if the sign-in goes away.
 *
 * The effective config is computed once per change, not per request: `config()` returns the cached object.
 */
export class SettingsService {
	readonly #db: Db;
	readonly #env: Env;
	readonly #fromEnv: Config;
	readonly #signIn: boolean;
	readonly #openAccess: boolean;
	readonly #now: () => number;
	readonly #listeners = new Set<SettingsListener>();
	#effective!: Config;
	#saved = new Map<EditableKey, string>();
	#ignored = new Map<EditableKey, string>();

	constructor(db: Db, env: Env, opts: { now?: () => number; fromEnv?: Config } = {}) {
		this.#db = db;
		this.#env = env;
		this.#fromEnv = opts.fromEnv ?? loadConfig(env);
		this.#now = opts.now ?? Date.now;
		const auth = effectiveAuth(this.#fromEnv).mode;
		this.#signIn = auth === 'forward' || auth === 'local';
		// The same test loadConfig uses for the read-only default (no sign-in at all).
		this.#openAccess = auth === 'none' || auth === 'local-disabled';
		this.#reload();
	}

	/** Whether the UI has a sign-in, which loosening the Porkbun read-only switch needs. */
	get signIn(): boolean {
		return this.#signIn;
	}

	get ignoringSaved(): boolean {
		return this.#fromEnv.settingsIgnore;
	}

	/** The config in force: saved, then environment, then default. */
	config(): Config {
		return this.#effective;
	}

	/** Saved values that are not in force, with the reason. Logged once at boot by `installSettings`. */
	warnings(): { key: EditableKey; message: string }[] {
		return [...this.#ignored].map(([key, message]) => ({ key, message }));
	}

	subscribe(fn: SettingsListener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	#readSaved(): Map<EditableKey, string> {
		const rows = this.#db
			.prepare(`SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'`)
			.all(`${KEY_PREFIX.replace(/[\\%_]/g, '\\$&')}%`) as { key: string; value: string }[];
		const out = new Map<EditableKey, string>();
		for (const r of rows) {
			const name = r.key.slice(KEY_PREFIX.length);
			// A key a newer build saved, or one that is no longer editable, is left alone and not used.
			if (isEditable(name)) out.set(name, r.value);
		}
		return out;
	}

	#reload(): void {
		this.#saved = this.#readSaved();
		this.#ignored = new Map();
		const overlay: Env = {};
		for (const [key, raw] of this.#saved) {
			if (this.ignoringSaved) {
				this.#ignored.set(key, 'CADDY_UI_SETTINGS_IGNORE is on, so saved settings are not used');
				continue;
			}
			try {
				overlay[key] = checkSetting(key, raw);
			} catch (err) {
				const why = err instanceof ConfigError ? err.message : String(err);
				this.#ignored.set(key, `The saved value "${raw}" is ignored: ${why}`);
				continue;
			}
			if (key === READONLY && overlay[key] !== undefined && !isTrue(overlay[key]) && !this.#signIn) {
				delete overlay[key];
				this.#ignored.set(
					key,
					'The saved value turns Porkbun writes on, which needs a sign-in; the UI has none, so it is ignored'
				);
			}
		}
		if (Object.keys(overlay).length === 0) {
			this.#effective = this.#fromEnv;
			return;
		}
		// Each value passed on its own above, and the environment passed at boot, so this does not throw.
		// The overlay is a copy: process.env (and with it Node's own TZ) is never changed.
		const merged = loadConfig({ ...this.#env, ...overlay });
		// Environment-only fields always come from the environment's own parse.
		this.#effective = {
			...this.#fromEnv,
			...pickEditable(merged),
			porkbun: { ...this.#fromEnv.porkbun, ...pickPorkbun(merged) }
		};
	}

	/** The view `GET /api/settings` returns. */
	view(): SettingsView {
		const eff = this.#effective;
		const editable: EditableSetting[] = EDITABLE.map((key) => {
			const env = envValue(this.#env, key);
			const saved = this.#saved.get(key) ?? null;
			const ignoredReason = this.#ignored.get(key);
			const def = key === READONLY ? String(this.#openAccess) : (EDITABLE_DEFAULTS[key] ?? null);
			const source = saved !== null && !ignoredReason ? 'saved' : env !== null ? 'env' : 'default';
			const value = source === 'saved' ? (saved as string).trim() || null : source === 'env' ? env : def;
			return {
				key,
				editable: true as const,
				value: key === 'CADDY_UI_PUBLIC_URL' ? (eff.publicUrl ?? null) : value,
				source,
				env,
				default: def,
				saved,
				...(ignoredReason ? { ignoredReason } : {})
			};
		});
		const envOnly: EnvOnlySetting[] = ENV_ONLY.map((d) => {
			const env = envValue(this.#env, d.key);
			const source = env !== null ? ('env' as const) : ('default' as const);
			if (d.secret)
				return { key: d.key, editable: false as const, source, secret: true as const, set: env !== null };
			return {
				key: d.key,
				editable: false as const,
				source,
				value: d.fromConfig ? d.fromConfig(this.#fromEnv) : env,
				default: d.default ?? null
			};
		});
		const settings: SettingRow[] = [...editable, ...envOnly];
		return {
			ignoringSaved: this.ignoringSaved,
			signIn: this.#signIn,
			settings,
			warnings: this.warnings(),
			log: this.log()
		};
	}

	log(limit = LOG_LIMIT): SettingsLogEntry[] {
		return (
			this.#db
				.prepare(
					`SELECT id, ts, author, key, old_value, new_value FROM settings_log ORDER BY id DESC LIMIT ?`
				)
				.all(limit) as {
				id: number;
				ts: number;
				author: string;
				key: string;
				old_value: string | null;
				new_value: string | null;
			}[]
		).map((r) => ({
			id: r.id,
			ts: r.ts,
			author: r.author,
			key: r.key,
			oldValue: r.old_value,
			newValue: r.new_value
		}));
	}

	/**
	 * Check every key in `patch`, then save them together in one transaction with a log row each, and tell
	 * the subscribers. A string saves a value; null removes the saved one. Throws `SettingsRefused` and saves
	 * nothing when any key fails.
	 */
	update(patch: SettingsPatch, author: string): SettingsView {
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new SettingsRefused(400, { message: 'Send a JSON object of settings', code: 'INVALID' });
		}
		const entries = Object.entries(patch);
		if (entries.length === 0) {
			throw new SettingsRefused(400, { message: 'Send at least one setting', code: 'INVALID' });
		}
		const errors: Record<string, string> = {};
		const changes: { key: EditableKey; value: string | null }[] = [];
		for (const [key, raw] of entries) {
			if (!isEditable(key)) {
				const known = ENV_ONLY.some((d) => d.key === key);
				throw new SettingsRefused(400, {
					message: known
						? `${key} can only be set in the environment, followed by a restart`
						: `${key} is not a setting`,
					code: known ? 'NOT_EDITABLE' : 'UNKNOWN_KEY'
				});
			}
			const text = asText(key, raw);
			if (text === null) {
				changes.push({ key, value: null });
				continue;
			}
			if (this.ignoringSaved) {
				throw new SettingsRefused(409, {
					message:
						'CADDY_UI_SETTINGS_IGNORE is on, so saved settings are not used and new ones are not taken. Resetting a value still works.',
					code: 'SETTINGS_IGNORED'
				});
			}
			try {
				const value = checkSetting(key, text);
				if (key === READONLY && !isTrue(value) && !this.#signIn) {
					throw new SettingsRefused(403, {
						message:
							'Porkbun writes can be turned on here only when the UI has a sign-in (forward auth, or a local user and password)',
						code: 'NEEDS_SIGN_IN'
					});
				}
				changes.push({ key, value });
			} catch (err) {
				if (err instanceof SettingsRefused) throw err;
				errors[key] = err instanceof ConfigError ? err.message : String(err);
			}
		}
		if (Object.keys(errors).length > 0) {
			const keys = Object.keys(errors);
			throw new SettingsRefused(400, {
				message:
					keys.length === 1 ? (errors[keys[0] as string] as string) : `${keys.length} settings are not valid`,
				code: 'INVALID',
				errors
			});
		}

		const prev = this.#effective;
		const ts = this.#now();
		const upsert = this.#db.prepare(
			`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`
		);
		const remove = this.#db.prepare(`DELETE FROM settings WHERE key = ?`);
		const logRow = this.#db.prepare(
			`INSERT INTO settings_log (ts, author, key, old_value, new_value) VALUES (?, ?, ?, ?, ?)`
		);
		this.#db.transaction(() => {
			for (const { key, value } of changes) {
				const old = this.#saved.get(key) ?? null;
				if (old === value) continue;
				if (value === null) remove.run(KEY_PREFIX + key);
				else upsert.run(KEY_PREFIX + key, value);
				logRow.run(ts, author, key, old, value);
			}
		})();
		this.#reload();
		this.#notify(prev);
		return this.view();
	}

	/** Tell subscribers which editable values changed in effect. A failing subscriber does not stop the rest. */
	#notify(prev: Config): void {
		const next = this.#effective;
		const changed = EDITABLE.filter((k) => effectiveOf(prev, k) !== effectiveOf(next, k));
		if (changed.length === 0) return;
		for (const fn of this.#listeners) {
			try {
				fn(next, prev, changed);
			} catch (err) {
				console.error('caddy-ui settings: a subscriber failed:', err);
			}
		}
	}
}

const isTrue = (v: string | undefined) => ['true', '1', 'yes', 'on'].includes((v ?? '').toLowerCase());

function pickEditable(c: Config) {
	return {
		probeIntervalMs: c.probeIntervalMs,
		scrapeIntervalMs: c.scrapeIntervalMs,
		retentionDays: c.retentionDays,
		certWarnDays: c.certWarnDays,
		probeTimeoutMs: c.probeTimeoutMs,
		revisionsKeep: c.revisionsKeep,
		backupsKeep: c.backupsKeep,
		timeZone: c.timeZone,
		publicUrl: c.publicUrl
	};
}

function pickPorkbun(c: Config) {
	return { readonly: c.porkbun.readonly, cacheTtlMs: c.porkbun.cacheTtlMs };
}

/** The effective value of one editable key, for change detection. */
export function effectiveOf(c: Config, key: EditableKey): string {
	switch (key) {
		case 'CADDY_UI_PROBE_INTERVAL':
			return String(c.probeIntervalMs);
		case 'CADDY_UI_SCRAPE_INTERVAL':
			return String(c.scrapeIntervalMs);
		case 'CADDY_UI_RETENTION_DAYS':
			return String(c.retentionDays);
		case 'TZ':
			return c.timeZone;
		case 'CADDY_UI_PUBLIC_URL':
			return c.publicUrl ?? '';
		case 'CADDY_UI_PORKBUN_READONLY':
			return String(c.porkbun.readonly);
		case 'CADDY_UI_PORKBUN_CACHE_TTL':
			return String(c.porkbun.cacheTtlMs);
		case 'CADDY_UI_CERT_WARN_DAYS':
			return String(c.certWarnDays);
		case 'CADDY_UI_PROBE_TIMEOUT':
			return String(c.probeTimeoutMs ?? '');
		case 'CADDY_UI_REVISIONS_KEEP':
			return String(c.revisionsKeep);
		case 'CADDY_UI_BACKUPS_KEEP':
			return String(c.backupsKeep);
	}
}
