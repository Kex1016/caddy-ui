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
	`,
	// 2 · W4 · Collector tables (PLAN.md §3.2) plus `sites` and `state_changes.target` (DECISIONS.md).
	`
	-- Every site block the collector has seen. id is the hash of the address list (PLAN.md §3.2).
	CREATE TABLE sites (
		id TEXT PRIMARY KEY,
		addresses_json TEXT NOT NULL,
		first_seen INTEGER NOT NULL,
		last_seen INTEGER NOT NULL,
		removed_at INTEGER
	);

	-- One row per probe. kind: 'site' (HTTP(S) through Caddy) or 'upstream' (TCP, plus HEAD when the
	-- scheme is known). ts in ms since the epoch.
	CREATE TABLE probes (
		site_id TEXT NOT NULL,
		target TEXT NOT NULL,
		kind TEXT NOT NULL,
		ts INTEGER NOT NULL,
		ok INTEGER NOT NULL,
		latency_ms REAL,
		status INTEGER,
		error TEXT
	);
	CREATE INDEX probes_site_ts ON probes (site_id, ts);
	CREATE INDEX probes_ts ON probes (ts);

	-- State flips. target '' is the site as a whole; otherwise the upstream address.
	CREATE TABLE state_changes (
		site_id TEXT NOT NULL,
		ts INTEGER NOT NULL,
		"from" TEXT NOT NULL,
		"to" TEXT NOT NULL,
		target TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX state_changes_site ON state_changes (site_id, target, ts);

	-- Per-minute series derived from Caddy's /metrics. ts is the minute start; labels_json is
	-- {"site":"<id>"} or {"site":"*"} for the whole server, or other labels for process metrics.
	CREATE TABLE metric_samples (
		ts INTEGER NOT NULL,
		name TEXT NOT NULL,
		labels_json TEXT NOT NULL,
		value REAL NOT NULL
	);
	CREATE INDEX metric_samples_lookup ON metric_samples (name, labels_json, ts);
	CREATE INDEX metric_samples_ts ON metric_samples (ts);

	-- Per-minute rollups of the JSON access log. site_id '*' is the whole server, '' a host that
	-- matches no site block. minute is the minute start in ms.
	CREATE TABLE log_minutes (
		site_id TEXT NOT NULL,
		minute INTEGER NOT NULL,
		requests INTEGER NOT NULL,
		errors_4xx INTEGER NOT NULL,
		errors_5xx INTEGER NOT NULL,
		bytes_out INTEGER NOT NULL,
		p50_ms REAL,
		p95_ms REAL,
		top_paths_json TEXT NOT NULL,
		top_ips_json TEXT NOT NULL,
		PRIMARY KEY (site_id, minute)
	);

	CREATE TABLE certs (
		host TEXT PRIMARY KEY,
		not_after INTEGER NOT NULL,
		issuer TEXT,
		seen_at INTEGER NOT NULL
	);
	`
];
