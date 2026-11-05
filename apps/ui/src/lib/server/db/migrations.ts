import type { Database } from 'better-sqlite3';

/**
 * Ordered schema migrations. Entry N (1-based) moves the database to `PRAGMA user_version = N`.
 * Append only: never edit or reorder an entry that has shipped. Each runs inside a transaction.
 * W3 owns migration 1 (revisions, settings); W4 appends the collector tables as migration 2.
 */
export type Migration = string | ((db: Database) => void);

export const migrations: Migration[] = [
	// 1 · W3 · Caddyfile history and key/value settings (PLAN.md §3.2).
	`
	CREATE TABLE revisions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		author TEXT NOT NULL,
		text TEXT NOT NULL,
		note TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX revisions_ts ON revisions (ts);
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	`
];
