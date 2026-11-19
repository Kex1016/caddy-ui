import { parseDuration } from './duration';

/** Runtime configuration, read once from the environment. Names and defaults are fixed in PLAN.md §3.2. */
export type AuthMode = 'local' | 'forward' | 'none';

export type Config = {
	port: number;
	adminUrl: string;
	caddyfilePath: string;
	logPath: string;
	dataPath: string;
	uiData: string;
	user: string | undefined;
	password: string | undefined;
	authMode: AuthMode;
	sessionSecret: string | undefined;
	probeIntervalMs: number;
	scrapeIntervalMs: number;
	retentionDays: number;
	/** `CADDY_UI_CERT_WARN_DAYS`: a certificate with fewer days left than this is flagged. */
	certWarnDays: number;
	/** `CADDY_UI_PROBE_TIMEOUT`; undefined means automatic (a third of the probe interval, 2 to 10 s). */
	probeTimeoutMs: number | undefined;
	/** `CADDY_UI_REVISIONS_KEEP`: Caddyfile revisions kept in the database. */
	revisionsKeep: number;
	/** `CADDY_UI_BACKUPS_KEEP`: Caddyfile backup files kept next to the database. */
	backupsKeep: number;
	publicUrl: string | undefined;
	updateIntervalMs: number;
	updateWebhookPort: number | undefined;
	updateSource: 'ghcr' | 'git';
	timeZone: string;
	porkbun: PorkbunConfig;
	/** `CADDY_UI_SETTINGS_IGNORE`: run on the environment and defaults only, ignoring saved settings. */
	settingsIgnore: boolean;
};

/** Porkbun settings (docs/porkbun-plan.md §3.2). Both keys unset means the Domains area is off. */
export type PorkbunConfig = {
	/** `PORKBUN_API_KEY`, trimmed. An empty value counts as unset. */
	apiKey: string | undefined;
	/** `PORKBUN_API_SECRET_KEY`, trimmed. An empty value counts as unset. */
	apiSecret: string | undefined;
	apiUrl: string;
	readonly: boolean;
	cacheTtlMs: number;
	sslKeyDownload: boolean;
};

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string, fallback: string): string {
	const v = env[name]?.trim();
	return v ? v : fallback;
}

function opt(env: Env, name: string): string | undefined {
	const v = env[name];
	return v === undefined || v === '' ? undefined : v;
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number, got "${raw}"`);
	const n = Number(raw);
	if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${n}`);
	return n;
}

function duration(env: Env, name: string, fallback: string, minMs: number): number {
	const raw = str(env, name, fallback);
	const ms = parseDuration(raw);
	if (ms === null) throw new ConfigError(`${name} must be a duration such as 30s, 5m or 1h, got "${raw}"`);
	if (ms < minMs) throw new ConfigError(`${name} must be at least ${minMs / 1000}s, got "${raw}"`);
	return ms;
}

function oneOf<T extends string>(env: Env, name: string, fallback: T, allowed: readonly T[]): T {
	const raw = str(env, name, fallback).toLowerCase();
	if (!(allowed as readonly string[]).includes(raw)) {
		throw new ConfigError(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
	}
	return raw as T;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
	const raw = env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	if (['true', '1', 'yes', 'on'].includes(raw)) return true;
	if (['false', '0', 'no', 'off'].includes(raw)) return false;
	throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

function url(env: Env, name: string, fallback: string | undefined): string | undefined {
	const raw = fallback === undefined ? opt(env, name)?.trim() : str(env, name, fallback);
	if (raw === undefined) return undefined;
	try {
		const u = new URL(raw);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
	} catch {
		throw new ConfigError(`${name} must be an http(s) URL, got "${raw}"`);
	}
	return raw.replace(/\/+$/, '');
}

/** An optional duration between `minMs` and `maxMs`; unset or empty means undefined (automatic). */
function optDuration(env: Env, name: string, minMs: number, maxMs: number): number | undefined {
	const raw = env[name]?.trim();
	if (!raw) return undefined;
	const ms = parseDuration(raw);
	if (ms === null) throw new ConfigError(`${name} must be a duration such as 5s or 1m, got "${raw}"`);
	if (ms < minMs || ms > maxMs) {
		throw new ConfigError(`${name} must be between ${minMs / 1000}s and ${maxMs / 1000}s, got "${raw}"`);
	}
	return ms;
}

function timeZone(env: Env): string {
	const tz = str(env, 'TZ', 'UTC');
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone: tz });
		return tz;
	} catch {
		throw new ConfigError(`TZ must be an IANA time zone such as Europe/Budapest, got "${tz}"`);
	}
}

/** A secret from the environment: trimmed, with an empty or all-blank value read as unset. */
function secret(env: Env, name: string): string | undefined {
	const v = env[name]?.trim();
	return v ? v : undefined;
}

function porkbun(env: Env, openAccess: boolean): PorkbunConfig {
	return {
		apiKey: secret(env, 'PORKBUN_API_KEY'),
		apiSecret: secret(env, 'PORKBUN_API_SECRET_KEY'),
		apiUrl: url(env, 'PORKBUN_API_URL', 'https://api.porkbun.com/api/json/v3') as string,
		// Anyone who can reach an unauthenticated UI could change DNS, so writes are opt-in there.
		readonly: bool(env, 'CADDY_UI_PORKBUN_READONLY', openAccess),
		cacheTtlMs: duration(env, 'CADDY_UI_PORKBUN_CACHE_TTL', '60s', 0),
		sslKeyDownload: bool(env, 'CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD', false)
	};
}

export function loadConfig(env: Env): Config {
	const updateWebhook = opt(env, 'CADDY_UI_UPDATE_WEBHOOK_PORT');
	const authMode = oneOf(env, 'CADDY_UI_AUTH_MODE', 'local', ['local', 'forward', 'none'] as const);
	const user = opt(env, 'CADDY_UI_USER');
	const password = opt(env, 'CADDY_UI_PASSWORD');
	// No sign-in at all: mode none, or local with neither a user nor a password (auth.ts "local-disabled").
	const openAccess = authMode === 'none' || (authMode === 'local' && !user && !password);
	return {
		port: int(env, 'CADDY_UI_PORT', 3001, 1, 65535),
		adminUrl: url(env, 'CADDY_ADMIN_URL', 'http://caddy:2019') as string,
		caddyfilePath: str(env, 'CADDYFILE_PATH', '/etc/caddy/Caddyfile'),
		logPath: str(env, 'CADDY_LOG_PATH', '/var/log/caddy/access.log'),
		dataPath: str(env, 'CADDY_DATA_PATH', '/data/caddy'),
		uiData: str(env, 'CADDY_UI_DATA', '/etc/caddy-ui'),
		user,
		password,
		authMode,
		sessionSecret: opt(env, 'CADDY_UI_SESSION_SECRET'),
		probeIntervalMs: duration(env, 'CADDY_UI_PROBE_INTERVAL', '30s', 1000),
		scrapeIntervalMs: duration(env, 'CADDY_UI_SCRAPE_INTERVAL', '15s', 1000),
		retentionDays: int(env, 'CADDY_UI_RETENTION_DAYS', 90, 1, 36500),
		certWarnDays: int(env, 'CADDY_UI_CERT_WARN_DAYS', 14, 1, 365),
		probeTimeoutMs: optDuration(env, 'CADDY_UI_PROBE_TIMEOUT', 1000, 60_000),
		revisionsKeep: int(env, 'CADDY_UI_REVISIONS_KEEP', 200, 10, 10000),
		backupsKeep: int(env, 'CADDY_UI_BACKUPS_KEEP', 50, 1, 10000),
		publicUrl: url(env, 'CADDY_UI_PUBLIC_URL', undefined),
		updateIntervalMs: duration(env, 'CADDY_UI_UPDATE_INTERVAL', '1h', 60_000),
		updateWebhookPort:
			updateWebhook === undefined ? undefined : int(env, 'CADDY_UI_UPDATE_WEBHOOK_PORT', 0, 1, 65535),
		updateSource: oneOf(env, 'CADDY_UI_UPDATE_SOURCE', 'ghcr', ['ghcr', 'git'] as const),
		timeZone: timeZone(env),
		porkbun: porkbun(env, openAccess),
		settingsIgnore: bool(env, 'CADDY_UI_SETTINGS_IGNORE', false)
	};
}

/**
 * The variables the Settings page can change while the UI runs (docs/settings-and-perf-plan.md §2.1). A saved
 * value is written in the same syntax as the variable and checked by the same parser, so the messages match.
 */
export const EDITABLE = [
	'CADDY_UI_PROBE_INTERVAL',
	'CADDY_UI_SCRAPE_INTERVAL',
	'CADDY_UI_RETENTION_DAYS',
	'TZ',
	'CADDY_UI_PUBLIC_URL',
	'CADDY_UI_PORKBUN_READONLY',
	'CADDY_UI_PORKBUN_CACHE_TTL',
	// S3: thresholds and history (docs/settings-and-perf-plan.md §3).
	'CADDY_UI_CERT_WARN_DAYS',
	'CADDY_UI_PROBE_TIMEOUT',
	'CADDY_UI_REVISIONS_KEEP',
	'CADDY_UI_BACKUPS_KEEP'
] as const;

export type EditableKey = (typeof EDITABLE)[number];

export function isEditable(key: string): key is EditableKey {
	return (EDITABLE as readonly string[]).includes(key);
}

/** Default of each editable variable, in its own syntax. `undefined` means unset. */
export const EDITABLE_DEFAULTS: Record<EditableKey, string | undefined> = {
	CADDY_UI_PROBE_INTERVAL: '30s',
	CADDY_UI_SCRAPE_INTERVAL: '15s',
	CADDY_UI_RETENTION_DAYS: '90',
	TZ: 'UTC',
	CADDY_UI_PUBLIC_URL: undefined,
	// Depends on the sign-in; see porkbun(). Shown as `false` with a sign-in and `true` without.
	CADDY_UI_PORKBUN_READONLY: undefined,
	CADDY_UI_PORKBUN_CACHE_TTL: '60s',
	CADDY_UI_CERT_WARN_DAYS: '14',
	// Unset means automatic: a third of the probe interval, between 2 and 10 seconds.
	CADDY_UI_PROBE_TIMEOUT: undefined,
	CADDY_UI_REVISIONS_KEEP: '200',
	CADDY_UI_BACKUPS_KEEP: '50'
};

const CHECKS: Record<EditableKey, (env: Env) => unknown> = {
	CADDY_UI_PROBE_INTERVAL: (e) => duration(e, 'CADDY_UI_PROBE_INTERVAL', '30s', 1000),
	CADDY_UI_SCRAPE_INTERVAL: (e) => duration(e, 'CADDY_UI_SCRAPE_INTERVAL', '15s', 1000),
	CADDY_UI_RETENTION_DAYS: (e) => int(e, 'CADDY_UI_RETENTION_DAYS', 90, 1, 36500),
	TZ: (e) => timeZone(e),
	CADDY_UI_PUBLIC_URL: (e) => url(e, 'CADDY_UI_PUBLIC_URL', undefined),
	CADDY_UI_PORKBUN_READONLY: (e) => bool(e, 'CADDY_UI_PORKBUN_READONLY', false),
	CADDY_UI_PORKBUN_CACHE_TTL: (e) => duration(e, 'CADDY_UI_PORKBUN_CACHE_TTL', '60s', 0),
	CADDY_UI_CERT_WARN_DAYS: (e) => int(e, 'CADDY_UI_CERT_WARN_DAYS', 14, 1, 365),
	CADDY_UI_PROBE_TIMEOUT: (e) => optDuration(e, 'CADDY_UI_PROBE_TIMEOUT', 1000, 60_000),
	CADDY_UI_REVISIONS_KEEP: (e) => int(e, 'CADDY_UI_REVISIONS_KEEP', 200, 10, 10000),
	CADDY_UI_BACKUPS_KEEP: (e) => int(e, 'CADDY_UI_BACKUPS_KEEP', 50, 1, 10000)
};

/** Keys where an empty value means "unset": no public URL, or the automatic probe timeout. */
const EMPTY_ALLOWED: ReadonlySet<EditableKey> = new Set(['CADDY_UI_PUBLIC_URL', 'CADDY_UI_PROBE_TIMEOUT']);

/**
 * Check one value for an editable variable with the parser `loadConfig` uses. Returns the value as it will
 * be stored (trimmed), or throws a ConfigError with the same message a bad environment variable gets. Only
 * `CADDY_UI_PUBLIC_URL` and `CADDY_UI_PROBE_TIMEOUT` may be empty, which means unset; anywhere else an empty value would silently mean
 * "the default", which is what removing the saved value is for.
 */
export function checkSetting(key: EditableKey, raw: string): string {
	const value = raw.trim();
	if (value === '' && !EMPTY_ALLOWED.has(key)) {
		throw new ConfigError(`${key} must not be empty; reset it to use the environment's value instead`);
	}
	CHECKS[key]({ [key]: value });
	return value;
}

let cached: Config | undefined;

/** The configuration from the environment alone. Throws a ConfigError naming the bad variable. */
export function envConfig(): Config {
	cached ??= loadConfig(process.env);
	return cached;
}

/** Turns the environment's config into the effective one. Installed by the settings service at boot. */
export type ConfigResolver = (fromEnv: Config) => Config;
let resolver: ConfigResolver | undefined;

export function setConfigResolver(r: ConfigResolver | undefined): void {
	resolver = r;
}

/**
 * The process-wide effective config: a saved setting, else the environment, else the default
 * (docs/configuration.md, "Settings and the environment"). Before the settings service is installed, and
 * for every environment-only variable, this is the environment's config. Read it per use rather than
 * keeping a copy, because editable values change while the UI runs.
 */
export function config(): Config {
	const fromEnv = envConfig();
	return resolver ? resolver(fromEnv) : fromEnv;
}
