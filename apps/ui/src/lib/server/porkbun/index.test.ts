import { isHttpError } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
	audit,
	auditLog,
	cached,
	invalidate,
	isConfigured,
	listDomains,
	porkbun,
	porkbunStatus,
	PorkbunNotConfigured,
	requireDomain,
	requireWritable,
	toResponse,
	write
} from './index';
import { PorkbunError, PorkbunUnreachable } from './errors';
import { resetPorkbunForTests, useFakePorkbun } from './testing';

afterEach(() => resetPorkbunForTests());

async function thrown(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	throw new Error('expected a throw');
}

function expectHttp(err: unknown, status: number, code: string): void {
	if (!isHttpError(err)) throw new Error(`expected an HttpError, got ${String(err)}`);
	expect(err.status).toBe(status);
	expect(err.body.code).toBe(code);
}

const ALL = ['read', 'dns', 'domains', 'email', 'hosting', 'purchase', 'funding', 'account'];

describe('with the keys unset', () => {
	it('is off and makes no call at all', async () => {
		const { fake } = useFakePorkbun({ settings: { apiKey: undefined, apiSecret: undefined } });
		expect(isConfigured()).toBe(false);
		expect(await porkbunStatus()).toEqual({ state: 'off', sandbox: false, readonly: false, scopes: [] });
		expect(await porkbunStatus({ force: true })).toMatchObject({ state: 'off' });
		expect(() => porkbun()).toThrow(PorkbunNotConfigured);
		expect(await thrown(() => requireDomain('example.com'))).toBeInstanceOf(PorkbunNotConfigured);
		expect(await thrown(() => requireWritable('dns'))).toBeInstanceOf(PorkbunNotConfigured);
		expect(await thrown(() => listDomains())).toBeInstanceOf(PorkbunNotConfigured);
		expect(fake.requests).toHaveLength(0);
	});

	it.each([
		[{ apiKey: undefined }, 'PORKBUN_API_KEY'],
		[{ apiSecret: undefined }, 'PORKBUN_API_SECRET_KEY']
	] as const)('names the one that is missing: %o', async (settings, name) => {
		const { fake } = useFakePorkbun({ settings });
		expect(isConfigured()).toBe(false);
		expect(await porkbunStatus()).toEqual({
			state: 'misconfigured',
			missing: name,
			sandbox: false,
			readonly: false,
			scopes: []
		});
		const err = (await thrown(() => porkbun())) as PorkbunNotConfigured;
		expect(err.missing).toBe(name);
		expect(err.message).toBe(`${name} is not set`);
		expect(fake.requests).toHaveLength(0);
	});

	it('answers routes with 503 NOT_CONFIGURED', async () => {
		useFakePorkbun({ settings: { apiKey: undefined, apiSecret: undefined } });
		const res = toResponse(await thrown(() => porkbun()));
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: 'NOT_CONFIGURED', error: { retryable: false } });
	});
});

describe('porkbunStatus', () => {
	it('reports ok with the scopes, public IP and account, and remembers it', async () => {
		let now = 1_000_000;
		const { fake } = useFakePorkbun({ now: () => now });
		expect(await porkbunStatus()).toEqual({
			state: 'ok',
			sandbox: false,
			readonly: false,
			scopes: ALL,
			publicIp: '203.0.113.10',
			account: 'example-account',
			checkedAt: 1_000_000
		});
		now += 59_000;
		await porkbunStatus();
		expect(fake.requests).toHaveLength(1);
		now += 2_000;
		await porkbunStatus();
		expect(fake.requests).toHaveLength(2);
		await porkbunStatus({ force: true });
		expect(fake.requests).toHaveLength(3);
	});

	it('shares one ping between concurrent callers', async () => {
		const { fake } = useFakePorkbun();
		await Promise.all([porkbunStatus(), porkbunStatus(), porkbunStatus()]);
		expect(fake.requests).toHaveLength(1);
	});

	it('reports read-only mode and a sandbox key', async () => {
		const { fake } = useFakePorkbun({ settings: { readonly: true } });
		expect(await porkbunStatus()).toMatchObject({ state: 'ok', readonly: true, sandbox: false });
		resetPorkbunForTests();
		const seed = { ...(await import('./testing')).fakeSeed(), apiKey: 'pk1_sb_fake_sandbox_key' };
		useFakePorkbun({ seed });
		expect(await porkbunStatus()).toMatchObject({ state: 'ok', sandbox: true });
		expect(fake.requests).toHaveLength(1);
	});

	it('reports a refused key as an error with what Porkbun said, and asks again after ten seconds', async () => {
		let now = 1_000_000;
		const { fake } = useFakePorkbun({ settings: { apiSecret: 'sk1_wrong_secret' }, now: () => now });
		const status = await porkbunStatus();
		expect(status).toMatchObject({
			state: 'error',
			scopes: [],
			error: { code: 'INVALID_API_KEYS_001', retryable: false, url: 'https://porkbun.com/account/api' }
		});
		now += 9_000;
		await porkbunStatus();
		expect(fake.requests).toHaveLength(1);
		now += 2_000;
		await porkbunStatus();
		expect(fake.requests).toHaveLength(2);
	});

	it('keeps the last known scopes and IP while Porkbun is unreachable', async () => {
		let now = 1_000_000;
		const { fake } = useFakePorkbun({ now: () => now });
		fake.scopes = ['read', 'dns'];
		await porkbunStatus();
		now += 120_000;
		fake.throwNext(new TypeError('fetch failed'));
		expect(await porkbunStatus()).toEqual({
			state: 'error',
			sandbox: false,
			readonly: false,
			scopes: ['read', 'dns'],
			publicIp: '203.0.113.10',
			account: 'example-account',
			checkedAt: 1_000_000,
			error: { code: 'UNREACHABLE', message: 'Porkbun could not be reached', retryable: true }
		});
	});
});

describe('requireDomain', () => {
	it('returns the domain for a name in the account, whatever its case', async () => {
		const { fake } = useFakePorkbun();
		expect(await requireDomain('Example.COM.')).toMatchObject({ domain: 'example.com', autoRenew: true });
		await requireDomain('example.net');
		expect(fake.requests.map((r) => r.path)).toEqual(['domain/listAll']);
	});

	it('answers 404 for a name that is not in the account, without sending the name to Porkbun', async () => {
		const { fake } = useFakePorkbun();
		expectHttp(await thrown(() => requireDomain('victim.example')), 404, 'DOMAIN_NOT_IN_ACCOUNT');
		expect(JSON.stringify(fake.requests)).not.toContain('victim');
	});

	it.each([
		'',
		' ',
		'..',
		'example',
		'exa mple.com',
		'../domain/listAll',
		'a.com/b',
		'-a.com',
		'a..com',
		'ex%61mple.com'
	])('answers 404 for %j without asking Porkbun anything', async (name) => {
		const { fake } = useFakePorkbun();
		expectHttp(await thrown(() => requireDomain(name)), 404, 'DOMAIN_NOT_IN_ACCOUNT');
		expect(fake.requests).toHaveLength(0);
	});

	it('reads the list again for a name that is missing from one older than five seconds', async () => {
		let now = 1_000_000;
		const { fake } = useFakePorkbun({ now: () => now });
		await requireDomain('example.com');
		const template = (await import('./testing')).fakeSeed().domains[0]!;
		fake.addDomain({ ...template, domain: 'new.example' });
		now += 1_000;
		expectHttp(await thrown(() => requireDomain('new.example')), 404, 'DOMAIN_NOT_IN_ACCOUNT');
		expect(fake.requests).toHaveLength(1);
		now += 5_000;
		expect((await requireDomain('new.example')).domain).toBe('new.example');
		expect(fake.requests).toHaveLength(2);
	});

	it('still knows the domains from the last good list while Porkbun is unreachable', async () => {
		let now = 1_000_000;
		const { fake } = useFakePorkbun({ now: () => now });
		await requireDomain('example.com');
		now += 120_000;
		fake.throwNext(new TypeError('fetch failed'));
		expect((await requireDomain('example.net')).domain).toBe('example.net');
		expect((await listDomains()).stale).toBe(false);
	});
});

describe('requireWritable', () => {
	it('allows a write the key may do', async () => {
		useFakePorkbun();
		expect(() => requireWritable('dns')).not.toThrow();
		await porkbunStatus();
		expect(() => requireWritable('dns')).not.toThrow();
		expect(() => requireWritable('domains')).not.toThrow();
	});

	it('answers 403 in read-only mode', async () => {
		useFakePorkbun({ settings: { readonly: true } });
		expectHttp(await thrown(() => requireWritable('dns')), 403, 'READ_ONLY');
	});

	it('answers 403 when the key is known to lack the scope', async () => {
		const { fake } = useFakePorkbun();
		fake.scopes = ['read', 'dns'];
		await porkbunStatus();
		expect(() => requireWritable('dns')).not.toThrow();
		const err = await thrown(() => requireWritable('domains'));
		expectHttp(err, 403, 'INSUFFICIENT_SCOPE');
		expect(isHttpError(err) && err.body.message).toContain('"domains" permission');
	});
});

describe('cached and invalidate', () => {
	it('go to the shared cache with the configured TTL', async () => {
		let now = 1_000_000;
		useFakePorkbun({ now: () => now, settings: { cacheTtlMs: 30_000 } });
		let calls = 0;
		const load = async () => ++calls;
		await cached('example.com:dns', load);
		now += 29_000;
		expect((await cached('example.com:dns', load)).data).toBe(1);
		now += 2_000;
		expect((await cached('example.com:dns', load)).data).toBe(2);
		invalidate('example.com');
		expect((await cached('example.com:dns', load)).data).toBe(3);
	});
});

describe('write', () => {
	const spec = (over: Partial<Parameters<typeof write>[0]> = {}) => ({
		scope: 'dns' as const,
		author: 'david',
		domain: 'example.com',
		action: 'dns.create',
		request: { host: 'api', type: 'A', content: '203.0.113.20' },
		run: (pb: ReturnType<typeof porkbun>) =>
			pb.dns.create('example.com', { host: 'api', type: 'A', content: '203.0.113.20' }),
		...over
	});

	it('sends the write, drops the cached reads for the domain and records it', async () => {
		const { fake } = useFakePorkbun();
		const load = () => porkbun().dns.list('example.com');
		expect((await cached('example.com:dns', load)).data.records).toHaveLength(11);
		await cached('example.net:dns', () => porkbun().dns.list('example.net'));
		const before = fake.requests.length;

		const res = await write(spec({ before: null }));
		if (!res.ok) throw new Error('expected success');
		const data = res.data as { id: string };
		expect(data).toEqual({ id: expect.stringMatching(/^\d+$/) });
		expect(res.warnings).toEqual([]);

		expect((await cached('example.com:dns', load)).data.records).toHaveLength(12);
		// The other domain's rows were left alone: one ping, the write, one reload.
		await cached('example.net:dns', () => porkbun().dns.list('example.net'));
		expect(fake.requests.slice(before).map((r) => r.path)).toEqual([
			'ping',
			'dns/create/example.com',
			'dns/retrieve/example.com'
		]);

		expect(auditLog().entries).toEqual([
			{
				id: res.auditId,
				ts: expect.any(Number),
				author: 'david',
				domain: 'example.com',
				action: 'dns.create',
				request: { host: 'api', type: 'A', content: '203.0.113.20' },
				before: null,
				ok: true,
				result: { id: data.id, warnings: [] },
				requestId: expect.stringMatching(/^fake-request-/)
			}
		]);
	});

	it('returns a refusal as a result and records it', async () => {
		useFakePorkbun();
		const res = await write(
			spec({
				run: (pb) => pb.dns.create('example.com', { host: 'www', type: 'CNAME', content: 'example.org' })
			})
		);
		expect(res).toMatchObject({
			ok: false,
			error: { code: 'RECORD_CONFLICT', retryable: false },
			auditId: expect.any(Number)
		});
		expect(auditLog({ domain: 'example.com' }).entries[0]).toMatchObject({
			ok: false,
			result: { error: { code: 'RECORD_CONFLICT' } },
			requestId: expect.stringMatching(/^fake-request-/)
		});
	});

	it('records a write that got no answer and drops the cache, because it may have happened', async () => {
		const { fake } = useFakePorkbun();
		await porkbunStatus();
		let loads = 0;
		const load = async () => ++loads;
		await cached('example.com:dns', load);
		fake.throwNext(new TypeError('fetch failed'));
		const res = await write(spec());
		expect(res).toMatchObject({ ok: false, error: { code: 'UNREACHABLE', retryable: true } });
		expect(auditLog().entries[0]).toMatchObject({ ok: false, action: 'dns.create' });
		expect((await cached('example.com:dns', load)).data).toBe(2);
	});

	it('sends nothing in read-only mode', async () => {
		const { fake } = useFakePorkbun({ settings: { readonly: true } });
		expectHttp(await thrown(() => write(spec())), 403, 'READ_ONLY');
		expect(fake.writes).toHaveLength(0);
		expect(auditLog().entries).toEqual([]);
	});

	it('sends nothing when the key lacks the scope', async () => {
		const { fake } = useFakePorkbun();
		fake.scopes = ['read'];
		expectHttp(await thrown(() => write(spec())), 403, 'INSUFFICIENT_SCOPE');
		expect(fake.writes).toHaveLength(0);
	});

	it('invalidates only what it is told to, and lets a bug through', async () => {
		useFakePorkbun();
		let dns = 0;
		let ns = 0;
		await cached('example.com:dns', async () => ++dns);
		await cached('example.com:ns', async () => ++ns);
		await write(spec({ invalidate: ['example.com:dns'] }));
		expect((await cached('example.com:dns', async () => ++dns)).data).toBe(2);
		expect((await cached('example.com:ns', async () => ++ns)).data).toBe(1);

		const bug = new Error('bug');
		expect(
			await thrown(() =>
				write(
					spec({
						run: async () => {
							throw bug;
						}
					})
				)
			)
		).toBe(bug);
	});
});

describe('audit', () => {
	it('appends a row and returns its id', () => {
		useFakePorkbun();
		const id = audit({
			author: 'david',
			domain: '',
			action: 'autorenew.set',
			request: { on: true },
			ok: true,
			result: {}
		});
		expect(auditLog().entries.map((e) => e.id)).toEqual([id]);
		expect(auditLog({ domain: 'example.com' }).entries).toEqual([]);
	});
});

describe('toResponse', () => {
	it.each([
		[new PorkbunError({ code: 'RATE_LIMIT_EXCEEDED', message: 'slow', httpStatus: 429, retryAfter: 7 }), 429],
		[new PorkbunError({ code: 'INSUFFICIENT_SCOPE', message: 'no', httpStatus: 403 }), 403],
		[new PorkbunError({ code: 'RESTORE_POINT_NOT_FOUND', message: 'no', httpStatus: 404 }), 404],
		[new PorkbunError({ code: 'IDEMPOTENCY_KEY_IN_USE', message: 'wait', httpStatus: 409 }), 409],
		[new PorkbunError({ code: 'DUPLICATE_RECORD', message: 'dup', httpStatus: 400 }), 422],
		[new PorkbunError({ code: 'DNS_READ_FAILED', message: 'oops', httpStatus: 500 }), 502],
		[new PorkbunUnreachable('Porkbun could not be reached', 'network'), 503]
	])('maps %s to HTTP %i', async (err, status) => {
		const res = toResponse(err);
		expect(res.status).toBe(status);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = await res.json();
		expect(body.error.code).toBe(body.code);
		expect(body.message).toBe(body.error.message);
		if (status === 429) expect(res.headers.get('retry-after')).toBe('7');
	});

	it('keeps only https links from Porkbun', async () => {
		const withUrl = (url: string) =>
			new PorkbunError({
				code: 'X',
				message: 'm',
				httpStatus: 400,
				nextAction: { type: 'use_website', url, retryable: false }
			});
		expect((await toResponse(withUrl('https://porkbun.com/account/api')).json()).error.url).toBe(
			'https://porkbun.com/account/api'
		);
		expect((await toResponse(withUrl('javascript:alert(1)')).json()).error.url).toBeUndefined();
		expect((await toResponse(withUrl('http://porkbun.com')).json()).error.url).toBeUndefined();
	});

	it('throws on what it does not know, so bugs and SvelteKit errors keep their own path', async () => {
		const bug = new Error('bug');
		expect(() => toResponse(bug)).toThrow(bug);
		useFakePorkbun();
		const notFound = await thrown(() => requireDomain('nope.example'));
		expect(() => toResponse(notFound)).toThrow();
	});
});
