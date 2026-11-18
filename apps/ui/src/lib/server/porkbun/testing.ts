import { openDb, setDbForTests, type Db } from '../db';
import type { PorkbunConfig } from '../env';
import { FakePorkbun, type FakeSeed } from './fake';
import seedJson from './fixtures/seed.json';
import { configurePorkbunForTests } from './index';

/**
 * Test helpers. Nothing here is imported by the app.
 *
 *     let ctx: FakeContext;
 *     beforeEach(() => (ctx = useFakePorkbun()));
 *     afterEach(() => resetPorkbunForTests());
 *
 * After `useFakePorkbun()` the whole module (`porkbun()`, `cached`, `write`, the routes) talks to an in-memory
 * Porkbun seeded from fixtures/seed.json and to an in-memory database. Nothing reaches the network.
 */

/** A fresh copy of fixtures/seed.json: three domains (`example.com`, `example.net`, `example.org`). */
export function fakeSeed(): FakeSeed {
	return structuredClone(seedJson) as FakeSeed;
}

export type FakeContext = { fake: FakePorkbun; db: Db; settings: PorkbunConfig };

export function useFakePorkbun(
	opts: { seed?: FakeSeed; settings?: Partial<PorkbunConfig>; now?: () => number } = {}
): FakeContext {
	const seed = opts.seed ?? fakeSeed();
	const fake = new FakePorkbun(seed, opts.now ? { now: opts.now } : {});
	const db = openDb(':memory:');
	setDbForTests(db);
	const settings: PorkbunConfig = {
		apiKey: seed.apiKey,
		apiSecret: seed.apiSecret,
		apiUrl: fake.baseUrl,
		readonly: false,
		cacheTtlMs: 60_000,
		sslKeyDownload: false,
		...opts.settings
	};
	configurePorkbunForTests({ settings, fetch: fake.fetch, db, ...(opts.now ? { now: opts.now } : {}) });
	return { fake, db, settings };
}

/** Undo `useFakePorkbun`: back to the environment and the real database handle. */
export function resetPorkbunForTests(): void {
	configurePorkbunForTests(undefined);
	setDbForTests(undefined);
}
