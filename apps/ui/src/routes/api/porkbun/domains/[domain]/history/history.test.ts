import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cached, RestorePoint, RestoreResult, WriteResult, ZoneDiff } from '$lib/api/porkbun';
import type { RestoreRehearsal } from '$lib/porkbun/registry/types';
import { auditLog, porkbun } from '$lib/server/porkbun';
import { resetPorkbunForTests, useFakePorkbun, type FakeContext } from '$lib/server/porkbun/testing';
import { GET as preflightRoute } from '../preflight/+server';
import { GET as diffRoute } from './[id]/diff/+server';
import { POST as restoreRoute } from './[id]/restore/+server';
import { GET as historyRoute } from './+server';

let ctx: FakeContext;
beforeEach(() => (ctx = useFakePorkbun()));
afterEach(() => resetPorkbunForTests());

const D = 'example.com';

function event(opts: { params?: Record<string, string>; query?: string; method?: string; body?: unknown }) {
	const url = new URL(`http://localhost/api/porkbun/domains/${D}/history${opts.query ?? ''}`);
	return {
		url,
		params: { domain: D, ...opts.params },
		request: new Request(url, {
			method: opts.method ?? 'GET',
			...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
		}),
		locals: { identity: { user: 'david', via: 'open' } }
	} as never;
}

async function thrown(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	throw new Error('expected a throw');
}

const live = () =>
	ctx.fake
		.records(D)
		.map((r) => `${r.host} ${r.type} ${r.content}`)
		.sort();

/** Make one restore point (the zone as seeded) and change the zone after it. */
async function arrange(): Promise<{ point: number; seeded: string[] }> {
	const seeded = live();
	await porkbun().dns.create(D, { host: 'new', type: 'A', content: '192.0.2.50' });
	const points = await porkbun().dns.history(D);
	return { point: points[0]!.id, seeded };
}

const restore = (id: number, body: unknown) =>
	restoreRoute(event({ params: { id: String(id) }, method: 'POST', body }));

describe('GET …/history', () => {
	it('lists the restore points, cached', async () => {
		const { point } = await arrange();
		const res = await historyRoute(event({}));
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = (await res.json()) as Cached<RestorePoint[]>;
		expect(body.stale).toBe(false);
		expect(body.data[0]).toMatchObject({ id: point, reason: 'before-create', matchesLive: false });
		const before = ctx.fake.requests.length;
		await historyRoute(event({}));
		expect(ctx.fake.requests.length).toBe(before);
		await historyRoute(event({ query: '?force' }));
		expect(ctx.fake.requests.length).toBe(before + 1);
	});

	it('is a 404 for a domain outside the account, before any call to it', async () => {
		const err = await thrown(() =>
			historyRoute({ ...(event({}) as object), params: { domain: 'not-mine.test' } } as never)
		);
		expect(isHttpError(err) && err.status).toBe(404);
		expect(ctx.fake.requests.some((r) => r.path.includes('not-mine'))).toBe(false);
	});
});

describe('GET …/history/:id/diff', () => {
	it('shows what a restore would add back and what it would prune', async () => {
		const { point } = await arrange();
		const res = await diffRoute(event({ params: { id: String(point) } }));
		const body = (await res.json()) as Cached<ZoneDiff>;
		expect(body.data.inSync).toBe(false);
		expect(body.data.missing).toEqual([]);
		expect(body.data.extra).toEqual([expect.objectContaining({ type: 'A', content: '192.0.2.50' })]);
	});

	it('refuses an id that is not a number and passes on an unknown one', async () => {
		expect((await diffRoute(event({ params: { id: 'abc' } }))).status).toBe(400);
		const res = await diffRoute(event({ params: { id: '999' } }));
		expect(res.status).toBe(404);
		expect((await res.json()).code).toBe('RESTORE_POINT_NOT_FOUND');
	});
});

describe('POST …/history/:id/restore', () => {
	it('rehearses first: a dry run changes nothing and is not logged', async () => {
		const { point } = await arrange();
		const before = live();
		const res = await restore(point, { dryRun: true, prune: true });
		expect(res.status).toBe(200);
		const body = (await res.json()) as RestoreRehearsal;
		expect(body.dryRun.wouldSucceed).toBe(true);
		expect(body.result).toMatchObject({ dryRun: true, removed: 1, restored: 0, previousStateSavedAs: null });
		expect(live()).toEqual(before);
		expect(auditLog({ domain: D }).entries).toHaveLength(0);
	});

	it('needs the domain typed to prune, and nothing is sent without it', async () => {
		const { point } = await arrange();
		const writes = ctx.fake.writes.length;
		const res = await restore(point, { prune: true });
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe('CONFIRMATION_REQUIRED');
		const wrong = await restore(point, { prune: true, confirm: 'example.net' });
		expect(wrong.status).toBe(400);
		expect(ctx.fake.writes.length).toBe(writes);
	});

	it('restores with prune, logs the diff as "before", and can be undone from previousStateSavedAs', async () => {
		const { point, seeded } = await arrange();
		const changed = live();
		const res = await restore(point, { prune: true, confirm: 'Example.com ' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as WriteResult<RestoreResult>;
		if (!body.ok) throw new Error('restore failed');
		expect(body.data).toMatchObject({ removed: 1, restored: 0, failed: [] });
		expect(live()).toEqual(seeded);

		const [entry] = auditLog({ domain: D }).entries;
		expect(entry).toMatchObject({
			action: 'dns.restore',
			ok: true,
			request: { snapshotId: point, prune: true }
		});
		expect((entry!.before as ZoneDiff).extra).toHaveLength(1);

		const undoId = body.data.previousStateSavedAs;
		expect(undoId).toEqual(expect.any(Number));
		const undo = await restore(undoId!, { prune: true, confirm: D });
		expect(((await undo.json()) as WriteResult).ok).toBe(true);
		expect(live()).toEqual(changed);
	});

	it('adds back deleted records without prune, and reports the ones Porkbun can not recreate', async () => {
		ctx.fake.setRecords(D, [
			{ name: '', type: 'A', content: '203.0.113.10', ttl: 600 },
			{ name: '', type: 'ALIAS', content: 'target.example.org', ttl: 600 }
		]);
		await porkbun().dns.create(D, { host: 'x', type: 'A', content: '192.0.2.9' });
		const [point] = await porkbun().dns.history(D);
		for (const r of ctx.fake.records(D)) {
			if (r.type === 'ALIAS' || r.host === '') await porkbun().dns.delete(D, r.id);
		}

		const rehearsal = (await (await restore(point!.id, { dryRun: true })).json()) as RestoreRehearsal;
		expect(rehearsal.result?.failed).toEqual([expect.objectContaining({ type: 'ALIAS' })]);

		const res = await restore(point!.id, {});
		const body = (await res.json()) as WriteResult<RestoreResult>;
		if (!body.ok) throw new Error('restore failed');
		expect(body.data.restored).toBe(1);
		expect(body.data.removed).toBe(0);
		expect(body.data.failed).toEqual([expect.objectContaining({ type: 'ALIAS' })]);
		expect(live()).toContain(' A 203.0.113.10');
		expect(live()).toContain('x A 192.0.2.9');
	});

	it('is refused in read-only mode, dry run included', async () => {
		resetPorkbunForTests();
		ctx = useFakePorkbun({ settings: { readonly: true } });
		const err = await thrown(() => restore(1, { dryRun: true }));
		expect(isHttpError(err) && err.status).toBe(403);
	});

	it('refuses a body that is not an object, and a prune that is not a flag', async () => {
		expect((await restore(1, [1, 2])).status).toBe(400);
		expect((await restore(1, { prune: 'yes' })).status).toBe(400);
	});
});

describe('GET …/preflight', () => {
	it('runs the check for an intent and refuses unknown intents', async () => {
		const res = await preflightRoute(event({ query: '?intent=move-nameservers' }));
		const body = await res.json();
		expect(body.data).toMatchObject({ intent: 'move-nameservers', blockers: [] });
		expect(ctx.fake.requests.at(-1)?.query.intent).toBe('move-nameservers');
		expect((await preflightRoute(event({ query: '?intent=nope' }))).status).toBe(400);
	});

	it('reports active DNSSEC as a blocker for a nameserver move', async () => {
		const res = await preflightRoute({
			...(event({ query: '?intent=move-nameservers' }) as object),
			params: { domain: 'example.net' }
		} as never);
		expect((await res.json()).data.blockers).toContain('dnssec-active');
	});
});
