import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './index';

describe('db', () => {
	it('migrates a fresh database to the newest version', () => {
		const db = openDb(':memory:');
		expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(1);
		db.prepare('INSERT INTO revisions (ts, author, text, note) VALUES (1, ?, ?, ?)').run('a', 'x', '');
		expect(db.prepare('SELECT count(*) AS n FROM revisions').get()).toEqual({ n: 1 });
	});

	it('is idempotent and applies only missing steps', () => {
		const db = openDb(':memory:');
		const before = db.pragma('user_version', { simple: true });
		migrate(db);
		expect(db.pragma('user_version', { simple: true })).toBe(before);
	});

	it('refuses a database newer than the build', () => {
		const db = openDb(':memory:');
		db.pragma('user_version = 999');
		expect(() => migrate(db)).toThrow(/newer than this build/);
	});

	it('rolls back a failing migration', () => {
		const db = openDb(':memory:');
		const v = db.pragma('user_version', { simple: true }) as number;
		const list = [...Array(v).fill('SELECT 1'), 'CREATE TABLE t (x); SELECT * FROM missing_table;'];
		expect(() => migrate(db, list)).toThrow();
		expect(db.pragma('user_version', { simple: true })).toBe(v);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeUndefined();
	});
});
