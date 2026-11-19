import type { Cached } from '$lib/api/porkbun';
import type { Db } from '../db';
import { PorkbunError, PorkbunUnreachable } from './errors';

/**
 * Read cache in SQLite (`porkbun_cache`, docs/porkbun-plan.md §3).
 *
 * Keys are `<domain>:<area>` (`example.com:dns`, `example.com:dns:history`) or `_account:<area>` for things
 * that belong to no single domain (`_account:domains`, `_account:pricing`). A domain name can not start with
 * an underscore, so the two never collide.
 *
 * - A fresh row is returned as it is. An expired or missing one is loaded and stored.
 * - If loading fails because Porkbun is unreachable or rate limiting, the last good row is returned with
 *   `stale: true`. Any other failure is thrown: an answer such as "this key may not do that" must not be
 *   papered over with old data.
 * - Concurrent loads of one key share a single request.
 * - The table is emptied when the process starts, because the keys can only change with a restart and rows
 *   from another account must never be shown.
 */
export class PorkbunCache {
	readonly #db: Db;
	#ttlMs: number;
	readonly #now: () => number;
	readonly #inflight = new Map<string, Promise<Cached<unknown>>>();

	constructor(db: Db, ttlMs: number, now: () => number = Date.now) {
		this.#db = db;
		this.#ttlMs = ttlMs;
		this.#now = now;
		this.clear();
	}

	/** How long a read stays fresh. Changing it applies to the next lookup, rows already stored included. */
	get ttlMs(): number {
		return this.#ttlMs;
	}

	set ttlMs(ms: number) {
		this.#ttlMs = ms;
	}

	clear(): void {
		this.#db.prepare('DELETE FROM porkbun_cache').run();
	}

	#read<T>(key: string): { data: T; fetchedAt: number } | undefined {
		const row = this.#db.prepare('SELECT fetched_at, json FROM porkbun_cache WHERE key = ?').get(key) as
			{ fetched_at: number; json: string } | undefined;
		if (!row) return undefined;
		try {
			return { data: JSON.parse(row.json) as T, fetchedAt: row.fetched_at };
		} catch {
			return undefined;
		}
	}

	async cached<T>(key: string, load: () => Promise<T>, opts: { force?: boolean } = {}): Promise<Cached<T>> {
		// The SSL bundle holds a private key. It is fetched on demand and never written anywhere.
		if (/(^|:)ssl(:|$)/.test(key)) throw new Error(`porkbun cache: "${key}" must not be cached`);
		const hit = this.#read<T>(key);
		if (hit && !opts.force && this.#now() - hit.fetchedAt < this.#ttlMs) return { ...hit, stale: false };

		const running = this.#inflight.get(key);
		if (running) return running as Promise<Cached<T>>;
		const run = (async (): Promise<Cached<T>> => {
			try {
				const data = await load();
				const fetchedAt = this.#now();
				this.#db
					.prepare(
						'INSERT INTO porkbun_cache (key, fetched_at, json) VALUES (?, ?, ?) ' +
							'ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json'
					)
					.run(key, fetchedAt, JSON.stringify(data));
				return { data, fetchedAt, stale: false };
			} catch (err) {
				const transient = err instanceof PorkbunUnreachable || (err instanceof PorkbunError && err.retryable);
				if (hit && transient) return { ...hit, stale: true };
				throw err;
			} finally {
				this.#inflight.delete(key);
			}
		})();
		this.#inflight.set(key, run);
		return run;
	}

	/** Drop every key equal to a prefix or below it: `invalidate('example.com:dns')`, `invalidate('example.com')`. */
	invalidate(...prefixes: string[]): void {
		const stmt = this.#db.prepare("DELETE FROM porkbun_cache WHERE key = ? OR key LIKE ? ESCAPE '\\'");
		for (const prefix of prefixes) {
			if (prefix === '') continue;
			stmt.run(prefix, prefix.replace(/[\\%_]/g, (c) => '\\' + c) + ':%');
		}
	}
}
