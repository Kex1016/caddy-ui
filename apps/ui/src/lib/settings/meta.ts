import type { EditableSetting, EnvOnlySetting, SettingRow, SettingsView } from '$lib/api/settings';

/**
 * What the Settings page says about each variable (docs/settings-and-perf-plan.md §2.1 and §2.3). Client-safe.
 * The server is the judge of a value; these only label and explain.
 */

export type FieldKind = 'duration' | 'days' | 'timezone' | 'url' | 'readonly';

export type FieldMeta = { label: string; hint: string; kind: FieldKind; placeholder?: string };

export const FIELDS: Record<string, FieldMeta> = {
	CADDY_UI_PROBE_INTERVAL: {
		label: 'Probe interval',
		hint: 'How often each site and upstream is checked. A duration such as 30s, 5m or 1h; at least 1s.',
		kind: 'duration',
		placeholder: '30s'
	},
	CADDY_UI_SCRAPE_INTERVAL: {
		label: 'Metrics interval',
		hint: 'How often Caddy’s metrics and its upstream list are read. At least 1s.',
		kind: 'duration',
		placeholder: '15s'
	},
	CADDY_UI_RETENTION_DAYS: {
		label: 'Keep probe results and metrics for',
		hint: 'Whole days, 1 to 36500. Access log minutes, status changes and certificates are kept regardless.',
		kind: 'days',
		placeholder: '90'
	},
	TZ: {
		label: 'Time zone',
		hint: 'How this UI shows times. An IANA name such as Europe/Budapest. The server’s own clock is not changed.',
		kind: 'timezone',
		placeholder: 'UTC'
	},
	CADDY_UI_PUBLIC_URL: {
		label: 'Public address',
		hint: 'The address you open this UI at, used in links and for the secure-cookie check. Leave empty for none.',
		kind: 'url',
		placeholder: 'https://caddy-ui.example.com'
	},
	CADDY_UI_PORKBUN_READONLY: {
		label: 'Porkbun changes',
		hint: 'Read-only refuses every change to Porkbun from this UI. Reading still works.',
		kind: 'readonly'
	},
	CADDY_UI_PORKBUN_CACHE_TTL: {
		label: 'Porkbun cache',
		hint: 'How long a Porkbun answer is reused before asking again. 0s asks every time.',
		kind: 'duration',
		placeholder: '60s'
	},
	CADDY_UI_UPDATE_INTERVAL: {
		label: 'Check for updates every',
		hint: 'How often the updater looks for a new version. 30s, 5m, 1h or 1d; at least 30s. The updater takes a change within a few seconds.',
		kind: 'duration',
		placeholder: '1h'
	}
};

/** The page's sections and the editable keys each one saves. Later workstreams (S3 to S6) add their own. */
export const SECTION_KEYS = {
	monitoring: ['CADDY_UI_PROBE_INTERVAL', 'CADDY_UI_SCRAPE_INTERVAL', 'CADDY_UI_RETENTION_DAYS'],
	display: ['TZ', 'CADDY_UI_PUBLIC_URL'],
	domains: ['CADDY_UI_PORKBUN_READONLY', 'CADDY_UI_PORKBUN_CACHE_TTL'],
	updates: ['CADDY_UI_UPDATE_INTERVAL']
} as const;

export type SectionId = keyof typeof SECTION_KEYS;

/** Plain-language names for the environment-only rows. */
export const ENV_LABELS: Record<string, string> = {
	CADDY_UI_AUTH_MODE: 'Sign-in mode',
	CADDY_UI_USER: 'User',
	CADDY_UI_PASSWORD: 'Password',
	CADDY_UI_SESSION_SECRET: 'Session secret',
	CADDY_ADMIN_URL: 'Caddy admin API',
	CADDYFILE_PATH: 'Caddyfile',
	CADDY_LOG_PATH: 'Access log',
	CADDY_DATA_PATH: 'Caddy data',
	CADDY_UI_DATA: 'UI data',
	CADDY_UI_PORT: 'Port',
	PORT: 'Port (Node)',
	HOST: 'Listen address',
	ORIGIN: 'Origin',
	PORKBUN_API_KEY: 'API key',
	PORKBUN_API_SECRET_KEY: 'Secret key',
	PORKBUN_API_URL: 'API address',
	CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD: 'Private key download',
	CADDY_UI_UPDATER_DIR: 'Updater channel directory',
	CADDY_UI_UPDATE_SOURCE: 'Update from',
	CADDY_UI_UPDATE_WEBHOOK_PORT: 'Push webhook port',
	CADDY_UI_SETTINGS_IGNORE: 'Ignore saved settings'
};

export function editable(view: SettingsView, key: string): EditableSetting | undefined {
	const row = view.settings.find((s) => s.key === key);
	return row && row.editable ? row : undefined;
}

export function envOnly(view: SettingsView, key: string): EnvOnlySetting | undefined {
	const row = view.settings.find((s) => s.key === key);
	return row && !row.editable ? row : undefined;
}

/**
 * What the form starts with: the saved text when something is saved (also when it is ignored for not passing its
 * check, so it can be fixed), else the value in force. With saved settings switched off (`locked`), the value in
 * force, because the form cannot save anyway and should not suggest the saved text applies.
 */
export function startValue(row: EditableSetting, locked = false): string {
	if (row.saved !== null && !locked) return row.saved;
	return row.value ?? '';
}

/** What applies when the saved value is removed, and where it comes from. */
export function fallback(row: EditableSetting): { value: string | null; from: 'env' | 'default' } {
	return row.env !== null ? { value: row.env, from: 'env' } : { value: row.default, from: 'default' };
}

/** One short line for where the value in force comes from. */
export function sourceLabel(row: SettingRow): string {
	if (row.source === 'saved') return 'Saved here';
	if (row.source === 'env') return 'From the environment';
	return 'Default';
}

/** The text shown for an environment-only row: the value (or its default), set/unset for a secret, or "not set". */
export function envOnlyText(row: EnvOnlySetting): string {
	if (row.secret) return row.set ? 'set' : 'not set';
	return row.value ?? row.default ?? 'not set';
}

const DAY = 86_400_000;

/**
 * Lowering retention deletes the oldest rows at the next hourly prune. About how many, assuming rows are spread
 * evenly in time (they are: one per target per probe cycle). `rows` is the table's row count when measured.
 */
export function rowsOlderThan(rows: number, oldestTs: number | null, days: number, now: number): number {
	if (oldestTs === null || rows <= 0) return 0;
	const cutoff = now - days * DAY;
	if (cutoff <= oldestTs) return 0;
	const span = now - oldestTs;
	if (span <= 0) return 0;
	return Math.round((rows * Math.min(cutoff - oldestTs, span)) / span);
}

export const TABLE_LABELS: Record<string, string> = {
	probes: 'Probe results',
	metric_samples: 'Caddy metrics',
	log_minutes: 'Access log, per minute',
	state_changes: 'Status changes',
	probe_latest: 'Latest probe per target',
	revisions: 'Caddyfile history',
	porkbun_cache: 'Porkbun cache',
	porkbun_audit: 'Porkbun activity',
	settings_log: 'Settings changes',
	settings: 'Saved settings',
	sites: 'Sites',
	certs: 'Certificates',
	sqlite_schema: 'Schema',
	sqlite_sequence: 'Counters',
	sqlite_stat1: 'Query planner statistics',
	sqlite_stat4: 'Query planner statistics'
};

export const tableLabel = (name: string): string => TABLE_LABELS[name] ?? name;
