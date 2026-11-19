/**
 * Response shapes of `/api/settings` (docs/settings-and-perf-plan.md §2.2), shared by the server and the
 * Settings page. Client-safe: no Node imports. Values are always strings in the variable's own syntax
 * (`30s`, `90`, `true`, `Europe/Budapest`), exactly as they would be written in compose.
 */

/** Where the effective value came from: a value saved in the UI, the environment, or the built-in default. */
export type SettingSource = 'saved' | 'env' | 'default';

/** A variable the UI can change while it runs. The value applies at once, without a restart. */
export type EditableSetting = {
	key: string;
	editable: true;
	/** The value in force. `null` only for `CADDY_UI_PUBLIC_URL` when it is unset. */
	value: string | null;
	source: SettingSource;
	/** The environment's value, or null when the variable is unset. */
	env: string | null;
	/** What applies when nothing is saved and the variable is unset. */
	default: string | null;
	/**
	 * The value saved in the UI, or null when nothing is saved. It can differ from `value` when it was
	 * ignored: see `ignoredReason`.
	 */
	saved: string | null;
	/** Set when a saved value exists but is not in force, with the reason. */
	ignoredReason?: string;
};

/** A variable shown for reference. It changes only in the environment (compose), followed by a restart. */
export type EnvOnlySetting = {
	key: string;
	editable: false;
	source: Exclude<SettingSource, 'saved'>;
	/** Only for secrets: the value is never sent, just whether it is set. */
	secret?: true;
	set?: boolean;
	/** The value in force; absent for secrets. */
	value?: string | null;
	default?: string | null;
};

export type SettingRow = EditableSetting | EnvOnlySetting;

/** `GET /api/settings`, and the answer to a successful `PATCH`. */
export type SettingsView = {
	/** `CADDY_UI_SETTINGS_IGNORE=true`: saved values are kept but not used, and saving is refused. */
	ignoringSaved: boolean;
	/** The UI has a sign-in (forward auth, or local auth with a user and password). */
	signIn: boolean;
	settings: SettingRow[];
	/** Saved values that are not in force, one line each; also written to the log at boot. */
	warnings: { key: string; message: string }[];
	/** The latest changes, newest first (at most 50). */
	log: SettingsLogEntry[];
};

/**
 * `PATCH /api/settings` body: `{ "CADDY_UI_PROBE_INTERVAL": "1m", "TZ": null }`. A string (numbers and
 * booleans are accepted and turned into strings) saves a value; `null` removes the saved value, so the
 * environment or the default applies again. All keys are checked first and saved together, or none is.
 */
export type SettingsPatch = Record<string, string | number | boolean | null>;

/** A refused `PATCH`: 400 with a message per key, or 403/409 with a code. */
export type SettingsError = {
	message: string;
	code: 'INVALID' | 'NOT_EDITABLE' | 'UNKNOWN_KEY' | 'NEEDS_SIGN_IN' | 'SETTINGS_IGNORED';
	errors?: Record<string, string>;
};

/** One row of the settings log, newest first. `null` means nothing was saved (environment or default). */
export type SettingsLogEntry = {
	id: number;
	ts: number;
	author: string;
	key: string;
	oldValue: string | null;
	newValue: string | null;
};
