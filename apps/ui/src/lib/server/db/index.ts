import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../env';
import { migrations, type Migration } from './migrations';

export type Db = Database.Database;

/** Bring a database to the newest schema. Each migration runs in its own transaction. */
export function migrate(db: Db, list: Migration[] = migrations): void {
	const current = db.pragma('user_version', { simple: true }) as number;
	if (current > list.length) {
		throw new Error(
			`Database schema version ${current} is newer than this build knows (${list.length}); refusing to run an older image against it`
		);
	}
	for (let v = current; v < list.length; v++) {
		const step = list[v] as Migration;
		db.transaction(() => {
			if (typeof step === 'string') db.exec(step);
			else step(db);
			db.pragma(`user_version = ${v + 1}`);
		})();
	}
}

/** Open (creating if needed) and migrate a database. Pass ':memory:' in tests. */
export function openDb(path: string): Db {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	db.pragma('busy_timeout = 5000');
	migrate(db);
	return db;
}

let shared: Db | undefined;

/** The process-wide database at `$CADDY_UI_DATA/caddy-ui.db`. */
export function getDb(): Db {
	shared ??= openDb(join(config().uiData, 'caddy-ui.db'));
	return shared;
}

/** Tests only: replace the shared handle (for example with an in-memory database). */
export function setDbForTests(db: Db | undefined): void {
	shared = db;
}
