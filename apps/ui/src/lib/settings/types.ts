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
