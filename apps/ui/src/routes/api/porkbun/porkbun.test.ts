import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { Porkbun } from '$lib/server/porkbun';
import { audit, porkbunStatus } from '$lib/server/porkbun';
import { resetPorkbunForTests, useFakePorkbun } from '$lib/server/porkbun/testing';
import { load as domainLayout } from '../../domains/[domain]/+layout.server';
import { load as domainsLayout } from '../../domains/+layout.server';
import { load as activityPage } from '../../domains/activity/+page.server';
import { GET as auditRoute } from './audit/+server';
import { GET as statusRoute } from './status/+server';

afterEach(() => resetPorkbunForTests());

const event = (path: string, params: Record<string, string> = {}) =>
	({
		url: new URL(`http://localhost${path}`),
		params,
		locals: { identity: { user: 'david', via: 'open' } }
	}) as never;

const off = { apiKey: undefined, apiSecret: undefined };

async function thrown(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	throw new Error('expected a throw');
}

describe('GET /api/porkbun/status', () => {
	it('says off with the keys unset and calls nothing', async () => {
		const { fake } = useFakePorkbun({ settings: off });
		const res = await statusRoute(event('/api/porkbun/status'));
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({ state: 'off', sandbox: false, readonly: false, scopes: [] });
		expect(fake.requests).toHaveLength(0);
	});

	it('names the missing key', async () => {
		useFakePorkbun({ settings: { apiSecret: undefined } });
		const res = await statusRoute(event('/api/porkbun/status'));
		expect(await res.json()).toMatchObject({ state: 'misconfigured', missing: 'PORKBUN_API_SECRET_KEY' });
	});

	it('reports a working key, and asks again only when forced', async () => {
		const { fake } = useFakePorkbun({ settings: { readonly: true } });
		const body = await (await statusRoute(event('/api/porkbun/status'))).json();
		expect(body).toMatchObject({
			state: 'ok',
			readonly: true,
			sandbox: false,
			publicIp: '203.0.113.10',
			account: 'example-account'
		});
		expect(body.scopes).toContain('dns');
		await statusRoute(event('/api/porkbun/status'));
		expect(fake.requests).toHaveLength(1);
		await statusRoute(event('/api/porkbun/status?force'));
		expect(fake.requests).toHaveLength(2);
	});

	it('reports a refused key as state error with a 200', async () => {
		useFakePorkbun({ settings: { apiKey: 'pk1_wrong' } });
		const res = await statusRoute(event('/api/porkbun/status'));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ state: 'error', error: { code: 'INVALID_API_KEYS_001' } });
	});
});

describe('GET /api/porkbun/audit', () => {
	const row = (domain: string, action = 'dns.create') =>
		audit({ author: 'david', domain, action, request: {}, ok: true, result: {} });

	it('lists the write log, newest first, and filters by domain', async () => {
		useFakePorkbun();
		row('example.com');
		row('example.net', 'ns.update');
		row('example.com', 'dns.delete');
		const all = await (await auditRoute(event('/api/porkbun/audit'))).json();
		expect(all.entries.map((e: { action: string }) => e.action)).toEqual([
			'dns.delete',
			'ns.update',
			'dns.create'
		]);
		expect(all.nextBefore).toBeNull();
		const one = await (await auditRoute(event('/api/porkbun/audit?domain=Example.NET'))).json();
		expect(one.entries).toHaveLength(1);
		expect(one.entries[0]).toMatchObject({ domain: 'example.net', author: 'david', ok: true });
	});

	it('pages with limit and before', async () => {
		useFakePorkbun();
		for (let i = 0; i < 5; i++) row('example.com');
		const first = await (await auditRoute(event('/api/porkbun/audit?limit=2'))).json();
		expect(first.entries).toHaveLength(2);
		const next = await (
			await auditRoute(event(`/api/porkbun/audit?limit=2&before=${first.nextBefore}`))
		).json();
		expect(next.entries.map((e: { id: number }) => e.id)).toEqual([3, 2]);
	});

	it.each(['limit=abc', 'before=-1', 'limit=0', 'before=1.5'])('answers 400 for ?%s', async (query) => {
		useFakePorkbun();
		const res = await auditRoute(event(`/api/porkbun/audit?${query}`));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
	});

	it('works with the keys unset', async () => {
		useFakePorkbun({ settings: off });
		expect(await (await auditRoute(event('/api/porkbun/audit'))).json()).toEqual({
			entries: [],
			nextBefore: null
		});
	});
});

describe('the Domains layout', () => {
	it('with the keys unset, loads the set-up state at /domains and sends every page below it there', async () => {
		const { fake } = useFakePorkbun({ settings: off });
		expect(await domainsLayout(event('/domains'))).toEqual({
			porkbun: { state: 'off', sandbox: false, readonly: false, scopes: [] }
		});
		for (const path of ['/domains/example.com', '/domains/example.com/dns', '/domains/activity']) {
			const err = await thrown(() => domainsLayout(event(path)));
			if (!isRedirect(err)) throw new Error('expected a redirect');
			expect(err.status).toBe(303);
			expect(err.location).toBe('/domains');
		}
		expect(await domainLayout(event('/domains/example.com', { domain: 'example.com' }))).toEqual({
			domain: null,
			domainError: null
		});
		expect(fake.requests).toHaveLength(0);
	});

	it('gives every page the status when the key works', async () => {
		useFakePorkbun();
		const data = (await domainsLayout(event('/domains/example.com/dns'))) as { porkbun: { state: string } };
		expect(data.porkbun.state).toBe('ok');
	});

	it('still loads when Porkbun refuses the key, so the pages can say why', async () => {
		useFakePorkbun({ settings: { apiSecret: 'sk1_wrong' } });
		const data = (await domainsLayout(event('/domains/activity'))) as { porkbun: { state: string } };
		expect(data.porkbun.state).toBe('error');
	});
});

describe('the domain layout', () => {
	it('loads the domain named in the path', async () => {
		useFakePorkbun();
		const data = await domainLayout(event('/domains/Example.com', { domain: 'Example.com' }));
		expect(data).toMatchObject({ domain: { domain: 'example.com', apiAccess: true }, domainError: null });
	});

	it('is a 404 for a domain that is not in the account', async () => {
		useFakePorkbun();
		const err = await thrown(() => domainLayout(event('/domains/nope.example', { domain: 'nope.example' })));
		if (!isHttpError(err)) throw new Error('expected an HttpError');
		expect(err.status).toBe(404);
	});

	it('explains itself when the domain list can not be read at all', async () => {
		const { fake } = useFakePorkbun();
		fake.throwNext(new TypeError('fetch failed'));
		const data = await domainLayout(event('/domains/example.com', { domain: 'example.com' }));
		expect(data).toEqual({
			domain: null,
			domainError: { code: 'UNREACHABLE', message: 'Porkbun could not be reached', retryable: true }
		});
	});
});

describe('the Activity page', () => {
	it('loads the write log, optionally for one domain', async () => {
		useFakePorkbun();
		audit({
			author: 'david',
			domain: 'example.com',
			action: 'dns.create',
			request: {},
			ok: true,
			result: {}
		});
		audit({
			author: 'david',
			domain: 'example.net',
			action: 'ns.update',
			request: {},
			ok: false,
			result: {}
		});
		const all = (await activityPage(event('/domains/activity'))) as {
			domain: string | null;
			log: { entries: unknown[] };
		};
		expect(all.domain).toBeNull();
		expect(all.log.entries).toHaveLength(2);
		const one = (await activityPage(event('/domains/activity?domain=EXAMPLE.net'))) as typeof all;
		expect(one.domain).toBe('example.net');
		expect(one.log.entries).toHaveLength(1);
	});
});

describe('the test guard', () => {
	it('stops a unit test from reaching the real Porkbun API', async () => {
		await expect(fetch('https://api.porkbun.com/api/json/v3/ping')).rejects.toThrow(
			/tried to reach api\.porkbun\.com/
		);
		// A client left on its default fetch is caught by the same guard.
		const pb = new Porkbun({
			apiKey: 'pk1_x',
			apiSecret: 'sk1_x',
			baseUrl: 'https://api-ipv4.porkbun.com/api/json/v3'
		});
		await expect(pb.ping()).rejects.toThrow('Porkbun could not be reached');
		await porkbunStatus().catch(() => undefined);
	});
});
