import { DISPLAY_KEYS, isDisplayChoice, parseDisplay, type Display, type DisplayKey } from '$lib/display';
import type { Db } from '../db';

/** Display preferences live in the shared `settings` table under this prefix, beside the `cfg.` keys. */
export const PREF_PREFIX = 'pref.';

export type PrefsListener = (next: Display, prev: Display) => void;

/** A value the page sent that is not one of the choices. */
export class PrefsRefused extends Error {
	constructor(
		readonly key: string,
		message: string
	) {
		super(message);
		this.name = 'PrefsRefused';
	}
}

/**
 * Display preferences (S6, D20). They are not environment variables, so there is no environment value to
 * fall back to: a missing key means the default. Read once, then kept in memory; `set` writes them in one
 * transaction and tells the listeners (the collector's snapshot follows the default range).
 */
export class Prefs {
	readonly #db: Db;
	readonly #listeners = new Set<PrefsListener>();
	#value: Display;

	constructor(db: Db) {
		this.#db = db;
		this.#value = this.#read();
	}

	#read(): Display {
		const rows = this.#db
			.prepare(`SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'`)
			.all(`${PREF_PREFIX}%`) as { key: string; value: string }[];
		return parseDisplay(Object.fromEntries(rows.map((r) => [r.key.slice(PREF_PREFIX.length), r.value])));
	}

	get(): Display {
		return this.#value;
	}

	/** Which preferences have been saved (the rest are on their default). */
	saved(): DisplayKey[] {
		const rows = this.#db
			.prepare(`SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\'`)
			.all(`${PREF_PREFIX}%`) as { key: string }[];
		const names = new Set(rows.map((r) => r.key.slice(PREF_PREFIX.length)));
		return DISPLAY_KEYS.filter((k) => names.has(k));
	}

	subscribe(fn: PrefsListener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/**
	 * Save some preferences. A value of `null` removes the saved one. Everything is checked first, so a bad
	 * value saves nothing.
	 */
	set(patch: Partial<Record<DisplayKey, string | null>>): Display {
		const entries = Object.entries(patch) as [DisplayKey, string | null][];
		for (const [key, value] of entries) {
			if (!DISPLAY_KEYS.includes(key)) throw new PrefsRefused(key, `Unknown preference ${key}`);
			if (value !== null && !isDisplayChoice(key, value)) {
				throw new PrefsRefused(key, `${JSON.stringify(value)} is not a choice for ${key}`);
			}
		}
		const prev = this.#value;
		this.#db.transaction(() => {
			const put = this.#db.prepare(
				'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
			);
			const drop = this.#db.prepare('DELETE FROM settings WHERE key = ?');
			for (const [key, value] of entries) {
				if (value === null) drop.run(PREF_PREFIX + key);
				else put.run(PREF_PREFIX + key, value);
			}
		})();
		this.#value = this.#read();
		for (const fn of this.#listeners) fn(this.#value, prev);
		return this.#value;
	}

	/** Back to the defaults. */
	reset(): Display {
		return this.set(Object.fromEntries(DISPLAY_KEYS.map((k) => [k, null])));
	}
}
