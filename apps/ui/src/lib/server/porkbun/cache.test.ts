import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db';
import { PorkbunCache } from './cache';
import { PorkbunError, PorkbunUnreachable } from './errors';

let db: Db;
let now: number;
let cache: PorkbunCache;

beforeEach(() => {
	db = openDb(':memory:');
	now = 1_000_000;
	cache = new PorkbunCache(db, 60_000, () => now);
});

const keys = () =>
	(db.prepare('SELECT key FROM porkbun_cache ORDER BY key').all() as { key: string }[]).map((r) => r.key);
const rateLimited = () =>
	new PorkbunError({ code: 'RATE_LIMIT_EXCEEDED', message: 'slow down', httpStatus: 429 });

describe('PorkbunCache', () => {
	it('loads once, then serves the row until the TTL passes', async () => {
		let calls = 0;
		const load = async () => ({ n: ++calls });
		expect(await cache.cached('example.com:dns', load)).toEqual({
			data: { n: 1 },
			fetchedAt: 1_000_000,
			stale: false
		});
		now += 59_999;
		expect(await cache.cached('example.com:dns', load)).toEqual({
			data: { n: 1 },
			fetchedAt: 1_000_000,
			stale: false
		});
		now += 1;
		expect(await cache.cached('example.com:dns', load)).toEqual({
			data: { n: 2 },
			fetchedAt: 1_060_000,
			stale: false
		});
	});

	it('loads again when forced', async () => {
		let calls = 0;
		const load = async () => ++calls;
		await cache.cached('k:a', load);
		expect((await cache.cached('k:a', load, { force: true })).data).toBe(2);
	});

	it('never caches with a TTL of zero', async () => {
		const off = new PorkbunCache(db, 0, () => now);
		let calls = 0;
		await off.cached('k:a', async () => ++calls);
		expect((await off.cached('k:a', async () => ++calls)).data).toBe(2);
	});

	it('shares one load between concurrent readers', async () => {
		let calls = 0;
		const load = () => new Promise<number>((resolve) => setTimeout(() => resolve(++calls), 5));
		const all = await Promise.all([
			cache.cached('k:a', load),
			cache.cached('k:a', load),
			cache.cached('k:a', load)
		]);
		expect(all.map((c) => c.data)).toEqual([1, 1, 1]);
	});

	it('serves the last good row as stale when Porkbun is unreachable or rate limiting', async () => {
		await cache.cached('k:a', async () => 'good');
		now += 120_000;
		const down = await cache.cached('k:a', async () => {
			throw new PorkbunUnreachable('Porkbun could not be reached', 'network');
		});
		expect(down).toEqual({ data: 'good', fetchedAt: 1_000_000, stale: true });
		const limited = await cache.cached('k:a', async () => {
			throw rateLimited();
		});
		expect(limited.stale).toBe(true);
	});

	it('throws when there is nothing to fall back on', async () => {
		await expect(
			cache.cached('k:a', async () => {
				throw new PorkbunUnreachable('Porkbun could not be reached', 'network');
			})
		).rejects.toBeInstanceOf(PorkbunUnreachable);
	});

	it('does not hide a refusal behind old data', async () => {
		await cache.cached('k:a', async () => 'good');
		now += 120_000;
		const denied = new PorkbunError({ code: 'INSUFFICIENT_SCOPE', message: 'no', httpStatus: 403 });
		await expect(
			cache.cached('k:a', async () => {
				throw denied;
			})
		).rejects.toBe(denied);
		const bug = new Error('bug');
		await expect(
			cache.cached('k:a', async () => {
				throw bug;
			})
		).rejects.toBe(bug);
	});

	it('invalidates a key and everything below it, and nothing else', async () => {
		for (const key of [
			'example.com:dns',
			'example.com:dns:history',
			'example.com:ns',
			'example.community:dns',
			'_account:domains',
			'xaccount:domains'
		]) {
			await cache.cached(key, async () => 1);
		}
		cache.invalidate('example.com:dns');
		expect(keys()).toEqual([
			'_account:domains',
			'example.com:ns',
			'example.community:dns',
			'xaccount:domains'
		]);
		cache.invalidate('example.com', '');
		expect(keys()).toEqual(['_account:domains', 'example.community:dns', 'xaccount:domains']);
		// '_' and '%' are LIKE wildcards; they must be taken literally.
		cache.invalidate('_account');
		expect(keys()).toEqual(['example.community:dns', 'xaccount:domains']);
		cache.invalidate('%');
		expect(keys()).toHaveLength(2);
	});

	it('starts empty, so rows from before a restart (and maybe another account) are never shown', async () => {
		await cache.cached('k:a', async () => 1);
		new PorkbunCache(db, 60_000, () => now);
		expect(keys()).toEqual([]);
	});

	it.each(['example.com:ssl', 'example.com:ssl:bundle', 'ssl'])(
		'refuses to cache the SSL bundle under %s',
		async (key) => {
			await expect(cache.cached(key, async () => ({ privateKey: 'x' }))).rejects.toThrow(
				/must not be cached/
			);
			expect(keys()).toEqual([]);
		}
	);
});
