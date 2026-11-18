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
	publicUrl: string | undefined;
	updateIntervalMs: number;
	updateWebhookPort: number | undefined;
	updateSource: 'ghcr' | 'git';
	timeZone: string;
	porkbun: PorkbunConfig;
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
		publicUrl: url(env, 'CADDY_UI_PUBLIC_URL', undefined),
		updateIntervalMs: duration(env, 'CADDY_UI_UPDATE_INTERVAL', '1h', 60_000),
		updateWebhookPort:
			updateWebhook === undefined ? undefined : int(env, 'CADDY_UI_UPDATE_WEBHOOK_PORT', 0, 1, 65535),
		updateSource: oneOf(env, 'CADDY_UI_UPDATE_SOURCE', 'ghcr', ['ghcr', 'git'] as const),
		timeZone: timeZone(env),
		porkbun: porkbun(env, openAccess)
	};
}

let cached: Config | undefined;

/** The process-wide config. Throws a ConfigError naming the bad variable if the environment is invalid. */
export function config(): Config {
	cached ??= loadConfig(process.env);
	return cached;
}
