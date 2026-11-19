/**
 * Shapes the Settings page's `load` returns besides `GET /api/settings` (docs/settings-and-perf-plan.md §2.3).
 * Client-safe: no Node imports.
 */

/** What SQLite and the file system answer at once, without reading the database. */
export type StorageFacts = {
	at: number;
	/** Size of the database file. */
	fileBytes: number;
	/** Size of its write-ahead log, which SQLite folds back into the file from time to time. */
	walBytes: number;
	/** Pages inside the file that are free and reused for new rows (the file does not shrink on its own). */
	freeInFileBytes: number;
	/** Free and total space on the volume that holds `CADDY_UI_DATA`; null when it cannot be read. */
	volumeFreeBytes: number | null;
	volumeTotalBytes: number | null;
	/** Oldest `ts` of each table the hourly prune trims, or null when the table is empty. */
	oldest: Partial<Record<'probes' | 'metric_samples', number | null>>;
};

/** One table with its indexes. `rows` is exact at the time of measuring. */
export type StorageTable = { name: string; bytes: number; rows: number };

/** Every table's size, measured off the main thread. */
export type StorageMeasure = {
	at: number;
	tookMs: number;
	tables: StorageTable[];
	error?: string;
};

export type PathCheckState = 'ok' | 'warning' | 'error';

/** One environment path with what the UI can do with it. */
export type PathCheck = {
	key: 'CADDYFILE_PATH' | 'CADDY_LOG_PATH' | 'CADDY_DATA_PATH' | 'CADDY_UI_DATA';
	path: string;
	state: PathCheckState;
	/** One short line: what was found, or what is wrong and what it costs. */
	message: string;
};

/** One storage job (prune now, compact) as the Settings page shows it. */
export type TaskState = {
	running: boolean;
	startedAt: number | null;
	finishedAt: number | null;
	/** One line on what it did, when it worked. */
	result: string | null;
	error: string | null;
};

export type MaintenanceState = { prune: TaskState; compact: TaskState; backupRunning: boolean };

/** `off`: the feature is not set up, which is fine (Porkbun keys unset, for example). */
export type DiagnosticState = 'ok' | 'warning' | 'error' | 'off';

/** One line of "Check everything" (docs/settings-and-perf-plan.md §3, Diagnostics). */
export type DiagnosticCheck = {
	id: string;
	label: string;
	state: DiagnosticState;
	/** What was found, in one sentence. */
	message: string;
	/** Optional extra lines: each job, each slow page, each path. */
	details?: { label: string; state: DiagnosticState; text: string }[];
	/** Where to fix it, when the UI can: a link on this page or elsewhere. */
	fix?: { href: string; label: string };
};

export type DiagnosticsReport = { at: number; tookMs: number; checks: DiagnosticCheck[] };

/** A one-click Caddyfile change from Settings → Caddy helpers, shown for review before it is applied. */
export type HelperId = 'metrics' | 'access-log';

export type HelperProposal = {
	helper: HelperId;
	/** The file as it is, and as it would be written. Equal when there is nothing to change. */
	before: string;
	after: string;
	baseHash: string;
	/** What the change does, one sentence. */
	summary: string;
	/** Things to know before applying it. */
	notes: string[];
};

/** Per-site probe options as the Settings page lists them. */
export type ProbeOptionsRow = {
	siteId: string;
	label: string;
	addresses: string[];
	skip: boolean;
	path: string | null;
	upStatuses: number[];
	/** The address the site is probed at now, with the path in force. */
	target: string | null;
};
