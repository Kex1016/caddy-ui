import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { PorkbunCache } from './cache';
import { porkbunStatus, reconfigurePorkbun } from '.';
import { resetPorkbunForTests, useFakePorkbun } from './testing';

afterEach(() => resetPorkbunForTests());

describe('live Porkbun settings', () => {
	it('a new cache TTL applies to the next lookup', async () => {
		let t = 0;
		const cache = new PorkbunCache(openDb(':memory:'), 60_000, () => t);
		let loads = 0;
		const load = async () => ++loads;
		await cache.cached('example.com:dns', load);
		t = 20_000;
		await cache.cached('example.com:dns', load);
		expect(loads).toBe(1);
		cache.ttlMs = 10_000;
		await cache.cached('example.com:dns', load);
		expect(loads).toBe(2);
	});

	it('the read-only switch changes the reported status at once', async () => {
		const ctx = useFakePorkbun();
		const first = await porkbunStatus();
		reconfigurePorkbun({ ...ctx.settings, readonly: !first.readonly, cacheTtlMs: 1_000 });
		const next = await porkbunStatus();
		expect(next.readonly).toBe(!first.readonly);
	});
});
