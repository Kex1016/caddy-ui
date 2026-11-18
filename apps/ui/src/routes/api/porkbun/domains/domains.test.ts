import { isHttpError } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry, DomainSummary, WriteResult, AutoRenewResult } from '$lib/api/porkbun';
import type { AccountInfo, BulkAutoRenew, DomainList, DomainOverview } from '$lib/porkbun/domains';
import { AUTO_RENEW_CHUNK } from '$lib/porkbun/domains/data.server';
import { auditLog, cached, listDomains, porkbun } from '$lib/server/porkbun';
import type { FakeDomainSeed } from '$lib/server/porkbun/fake';
import { fakeSeed, resetPorkbunForTests, useFakePorkbun } from '$lib/server/porkbun/testing';
import { load as overviewPage } from '../../../domains/[domain]/+page.server';
import { load as listPage } from '../../../domains/+page.server';
import { GET as accountRoute } from '../account/+server';
import { PUT as bulkRoute } from '../auto-renew/+server';
import { GET as detailRoute } from './[domain]/+server';
import { PUT as autoRenewRoute } from './[domain]/auto-renew/+server';
import { GET as listRoute } from './+server';

afterEach(() => resetPorkbunForTests());

const event = (path: string, params: Record<string, string> = {}, body?: unknown, method = 'GET') =>
	({
		url: new URL(`http://localhost${path}`),
		params,
		locals: { identity: { user: 'david', via: 'open' } },
		request: new Request(`http://localhost${path}`, {
			method,
			...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
		})
	}) as never;

const put = (path: string, params: Record<string, string>, body: unknown) => event(path, params, body, 'PUT');

async function thrown(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	throw new Error('expected a throw');
}

const writesTo = (fake: { requests: { method: string; path: string }[] }, op: string) =>
	fake.requests.filter((r) => r.method === 'POST' && r.path.startsWith(op));

function extraDomain(i: number, patch: Partial<FakeDomainSeed> = {}): FakeDomainSeed {
	return {
		domain: `bulk-${String(i).padStart(4, '0')}.com`,
		status: 'ACTIVE',
		createDate: '2022-02-02 02:02:02',
		expireDate: '2027-02-02 02:02:02',
		securityLock: 1,
		whoisPrivacy: 1,
		autoRenew: 1,
		apiAccess: 1,
		notLocal: 0,
		ns: [],
		records: [],
		...patch
	};
}

describe('GET /api/porkbun/domains', () => {
	it('lists every domain with its renewal price, and every flag matches /domain/get', async () => {
		useFakePorkbun();
		const res = await listRoute(event('/api/porkbun/domains'));
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = (await res.json()) as DomainList;
		expect(body.pricingError).toBeNull();
		expect(body.stale).toBe(false);
		expect(body.data.map((d) => [d.domain, d.renewal]).sort()).toEqual([
			['example.com', '11.08'],
			['example.net', '12.52'],
			['example.org', '10.74']
		]);
		for (const row of body.data) {
			const { renewal: _renewal, ...summary } = row;
			const detail: DomainSummary = await porkbun().domains.get(row.domain);
			expect(summary).toEqual(detail);
		}
		const net = body.data.find((d) => d.domain === 'example.net');
		expect(net).toMatchObject({ autoRenew: false, securityLock: false, whoisPrivacy: true });
		expect(body.data.find((d) => d.domain === 'example.org')?.apiAccess).toBe(false);
	});

	it('is cached, and ?force asks Porkbun again', async () => {
		const { fake } = useFakePorkbun();
		await listRoute(event('/api/porkbun/domains'));
		const asked = fake.requests.length;
		await listRoute(event('/api/porkbun/domains'));
		expect(fake.requests.length).toBe(asked);
		await listRoute(event('/api/porkbun/domains?force'));
		expect(fake.requests.length).toBe(asked * 2);
	});

	it('still lists the domains when the price list can not be read', async () => {
		const { fake } = useFakePorkbun();
		await listDomains(); // cached, so the next request the route makes is the price list
		fake.throwNext(new TypeError('fetch failed'));
		const res = await listRoute(event('/api/porkbun/domains'));
		const body = (await res.json()) as DomainList;
		expect(res.status).toBe(200);
		expect(body.data.map((d) => d.renewal)).toEqual([null, null, null]);
		expect(body.pricingError).toMatchObject({ code: 'UNREACHABLE', retryable: true });
	});

	it('answers 503 with the reason when Porkbun is down and nothing is cached', async () => {
		const { fake } = useFakePorkbun();
		fake.throwNext(new TypeError('fetch failed'));
		fake.throwNext(new TypeError('fetch failed'));
		const res = await listRoute(event('/api/porkbun/domains'));
		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(await res.json()).toMatchObject({ code: 'UNREACHABLE' });
	});

	it('handles 1,000 domains well inside the page budget', async () => {
		const seed = fakeSeed();
		for (let i = 0; i < 997; i++) seed.domains.push(extraDomain(i));
		useFakePorkbun({ seed });
		const started = performance.now();
		const res = await listRoute(event('/api/porkbun/domains'));
		const body = (await res.json()) as DomainList;
		const ms = performance.now() - started;
		expect(body.data).toHaveLength(1000);
		expect(ms).toBeLessThan(500);
	});
});

describe('GET /api/porkbun/domains/:d', () => {
	const overview = async (name: string) => {
		const res = await detailRoute(event(`/api/porkbun/domains/${name}`, { domain: name }));
		expect(res.status).toBe(200);
		return (await res.json()) as DomainOverview;
	};

	it('gives the registry details, the price, the nameservers and the counts', async () => {
		const { fake } = useFakePorkbun();
		const body = await overview('example.com');
		expect(body.detail).toMatchObject({ ok: true, data: await porkbun().domains.get('example.com') });
		expect(body.renewal).toBe('11.08');
		expect(body.nameservers).toMatchObject({ ok: true, data: { kind: 'porkbun' } });
		expect(body.dns).toMatchObject({ ok: true, data: { total: fake.records('example.com').length } });
		expect(body.forwards).toMatchObject({ ok: true, data: 1 });
		expect(body.glue).toMatchObject({ ok: true, data: 1 });
		expect(body.dnssec).toMatchObject({ ok: true, data: 0 });
		expect(body.history.ok).toBe(true);
	});

	it("reads the nameservers through P3's cache key, in P3's shape", async () => {
		const { fake } = useFakePorkbun();
		await overview('example.net');
		const asked = fake.requests.length;
		const hit = await cached<string[]>('example.net:ns', () => Promise.reject(new Error('not cached')));
		expect(hit.data).toEqual(['ns1.example-dns.net', 'ns2.example-dns.net']);
		expect(fake.requests.length).toBe(asked);
	});

	it('says when the nameservers are elsewhere', async () => {
		useFakePorkbun();
		const body = await overview('example.net');
		expect(body.nameservers).toMatchObject({
			ok: true,
			data: { kind: 'custom', ns: ['ns1.example-dns.net', 'ns2.example-dns.net'] }
		});
		expect(body.dnssec).toMatchObject({ ok: true, data: 1 });
		expect(body.detail).toMatchObject({ ok: true, data: { autoRenew: false } });
	});

	it('does not ask for what Porkbun refuses on a domain with API access off', async () => {
		const { fake } = useFakePorkbun();
		const body = await overview('example.org');
		for (const p of [body.nameservers, body.dns, body.history, body.forwards, body.glue, body.dnssec]) {
			expect(p).toMatchObject({ ok: false, error: { code: 'API_ACCESS_DISABLED' } });
		}
		const asked = fake.requests.map((r) => r.path);
		expect(asked.filter((p) => p.includes('example.org') && !p.startsWith('domain/get'))).toEqual([]);
	});

	it('is a 404 for a domain not in the account, and nothing is sent with that name', async () => {
		const { fake } = useFakePorkbun();
		const err = await thrown(() =>
			detailRoute(event('/api/porkbun/domains/other.com', { domain: 'other.com' }))
		);
		expect(isHttpError(err) && err.status).toBe(404);
		expect(fake.requests.some((r) => r.path.includes('other.com'))).toBe(false);
	});

	it('keeps the parts that worked when one read fails', async () => {
		const { fake } = useFakePorkbun();
		await overview('example.com');
		fake.respondNext({
			status: 400,
			body: { status: 'ERROR', code: 'INSUFFICIENT_SCOPE', message: 'No.' }
		});
		const res = await detailRoute(event('/api/porkbun/domains/example.com?force', { domain: 'example.com' }));
		const body = (await res.json()) as DomainOverview;
		const parts = [
			body.detail,
			body.nameservers,
			body.dns,
			body.history,
			body.forwards,
			body.glue,
			body.dnssec
		];
		expect(parts.filter((p) => !p.ok)).toHaveLength(1);
	});
});

describe('auto-renew', () => {
	it('turns it off for one domain, logs it with the state before, and the list shows it at once', async () => {
		const { fake } = useFakePorkbun();
		await listRoute(event('/api/porkbun/domains')); // cache the list
		const res = await autoRenewRoute(
			put('/api/porkbun/domains/example.com/auto-renew', { domain: 'example.com' }, { on: false })
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as WriteResult<{ results: AutoRenewResult[] }>;
		expect(body).toMatchObject({ ok: true, data: { results: [{ domain: 'example.com', ok: true }] } });
		expect(writesTo(fake, 'domain/updateAutoRenew')).toHaveLength(1);

		const list = (await (await listRoute(event('/api/porkbun/domains'))).json()) as DomainList;
		expect(list.data.find((d) => d.domain === 'example.com')?.autoRenew).toBe(false);

		const [entry] = auditLog({ domain: 'example.com' }).entries as AuditEntry[];
		expect(entry).toMatchObject({
			action: 'autorenew.set',
			author: 'david',
			ok: true,
			before: { autoRenew: { 'example.com': true } },
			request: { domains: ['example.com'], autoRenew: false }
		});
	});

	it('refuses a bad body before anything is sent', async () => {
		const { fake } = useFakePorkbun();
		for (const body of [{ on: 'yes' }, {}, [], 'not json']) {
			const err = await thrown(() =>
				autoRenewRoute(put('/api/porkbun/domains/example.com/auto-renew', { domain: 'example.com' }, body))
			);
			expect(isHttpError(err) && err.status).toBe(400);
		}
		expect(writesTo(fake, 'domain/')).toHaveLength(0);
	});

	it('is refused in read-only mode and without the domains permission, with nothing sent', async () => {
		const ro = useFakePorkbun({ settings: { readonly: true } });
		const err = await thrown(() =>
			autoRenewRoute(
				put('/api/porkbun/domains/example.com/auto-renew', { domain: 'example.com' }, { on: false })
			)
		);
		expect(isHttpError(err) && err.status).toBe(403);
		expect(writesTo(ro.fake, 'domain/')).toHaveLength(0);

		resetPorkbunForTests();
		const narrow = useFakePorkbun();
		narrow.fake.scopes = ['read', 'dns'];
		const err2 = await thrown(() =>
			bulkRoute(put('/api/porkbun/auto-renew', {}, { on: false, domains: ['example.com'] }))
		);
		expect(isHttpError(err2) && err2.status).toBe(403);
		expect(writesTo(narrow.fake, 'domain/')).toHaveLength(0);
	});

	it('reports per domain in bulk, logged as one account-wide change', async () => {
		const { fake } = useFakePorkbun();
		const res = await bulkRoute(
			put(
				'/api/porkbun/auto-renew',
				{},
				{ on: false, domains: ['example.com', 'Example.org', 'example.com'] }
			)
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as BulkAutoRenew;
		expect(body.results).toEqual([
			{ domain: 'example.com', ok: true, message: expect.any(String) },
			{ domain: 'example.org', ok: false, message: expect.stringContaining('API access') }
		]);
		expect(body.auditIds).toHaveLength(1);
		expect(writesTo(fake, 'domain/updateAutoRenew')).toHaveLength(1);
		const [entry] = auditLog().entries;
		expect(entry).toMatchObject({ domain: '', action: 'autorenew.set' });
	});

	it('refuses the whole bulk request when one name is not in the account', async () => {
		const { fake } = useFakePorkbun();
		const err = await thrown(() =>
			bulkRoute(put('/api/porkbun/auto-renew', {}, { on: true, domains: ['example.com', 'other.com'] }))
		);
		expect(isHttpError(err) && err.status).toBe(404);
		expect(writesTo(fake, 'domain/')).toHaveLength(0);
	});

	it(`sends ${AUTO_RENEW_CHUNK} domains per request and reports every one`, async () => {
		const seed = fakeSeed();
		const extra = Array.from({ length: 250 }, (_, i) => extraDomain(i));
		seed.domains.push(...extra);
		const { fake } = useFakePorkbun({ seed });
		const names = extra.map((d) => d.domain);
		const body = (await (
			await bulkRoute(put('/api/porkbun/auto-renew', {}, { on: false, domains: names }))
		).json()) as BulkAutoRenew;
		expect(writesTo(fake, 'domain/updateAutoRenew')).toHaveLength(3);
		expect(body.results.map((r) => r.domain)).toEqual(names);
		expect(body.results.every((r) => r.ok)).toBe(true);
		expect(body.auditIds).toHaveLength(3);
	});

	it('marks every domain of a request that failed as a whole, and goes on with the rest', async () => {
		const seed = fakeSeed();
		const extra = Array.from({ length: AUTO_RENEW_CHUNK + 1 }, (_, i) => extraDomain(i));
		seed.domains.push(...extra);
		const { fake } = useFakePorkbun({ seed });
		const names = extra.map((d) => d.domain);
		await bulkRoute(put('/api/porkbun/auto-renew', {}, { on: true, domains: names.slice(0, 1) })); // warm
		await listDomains(); // the write dropped the cached list; read it again so the next request is the write
		fake.respondNext({
			status: 503,
			body: { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', message: 'Down.' }
		});
		const res = await bulkRoute(put('/api/porkbun/auto-renew', {}, { on: false, domains: names }));
		const body = (await res.json()) as BulkAutoRenew;
		expect(res.status).toBe(200);
		expect(body.results).toHaveLength(names.length);
		expect(body.results.slice(0, AUTO_RENEW_CHUNK).every((r) => !r.ok)).toBe(true);
		expect(body.results.at(-1)?.ok).toBe(true);
	});
});

describe('GET /api/porkbun/account', () => {
	it('gives the credit and the spend settings', async () => {
		useFakePorkbun();
		const body = (await (await accountRoute(event('/api/porkbun/account'))).json()) as AccountInfo;
		expect(body.balance).toMatchObject({ ok: true, data: { cents: 2500, display: '$25.00' } });
		expect(body.spend).toMatchObject({ ok: true, data: { spendLimit: { remaining: 10000 } } });
	});

	it('reports a refused half without failing the other', async () => {
		const { fake } = useFakePorkbun();
		fake.respondNext({
			status: 403,
			body: {
				status: 'ERROR',
				code: 'INSUFFICIENT_SCOPE',
				message: 'This API key does not have the "account" permission.'
			}
		});
		const body = (await (await accountRoute(event('/api/porkbun/account'))).json()) as AccountInfo;
		expect([body.balance.ok, body.spend.ok].sort()).toEqual([false, true]);
	});
});

describe('page loads', () => {
	it('make no call with the keys unset', async () => {
		const { fake } = useFakePorkbun({ settings: { apiKey: undefined, apiSecret: undefined } });
		expect(await listPage(event('/domains'))).toMatchObject({ list: null, account: null });
		expect(await overviewPage(event('/domains/example.com', { domain: 'example.com' }))).toMatchObject({
			overview: null
		});
		expect(fake.requests).toHaveLength(0);
	});

	it('hand an unreadable list to the page instead of throwing', async () => {
		const { fake } = useFakePorkbun();
		for (let i = 0; i < 5; i++) fake.throwNext(new TypeError('fetch failed'));
		const data = (await listPage(event('/domains'))) as { list: unknown; listError: { code: string } };
		expect(data.list).toBeNull();
		expect(data.listError.code).toBe('UNREACHABLE');
	});

	it('give the overview its recent changes', async () => {
		useFakePorkbun();
		await autoRenewRoute(
			put('/api/porkbun/domains/example.net/auto-renew', { domain: 'example.net' }, { on: true })
		);
		const data = (await overviewPage(event('/domains/example.net', { domain: 'example.net' }))) as {
			overview: DomainOverview;
			recent: AuditEntry[];
		};
		expect(data.overview.detail).toMatchObject({ ok: true, data: { autoRenew: true } });
		expect(data.recent.map((e) => e.action)).toEqual(['autorenew.set']);
	});
});
