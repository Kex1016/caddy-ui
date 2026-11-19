import { beforeEach, describe, expect, it } from 'vitest';
import { hostOf, isoDate, Porkbun } from './client';
import { PorkbunError, PorkbunUnreachable } from './errors';
import { FakePorkbun } from './fake';
import { fakeSeed } from './testing';

// Every endpoint in docs/porkbun-plan.md §2 has a client method, tested here against the in-memory fake.
// Nothing in this file can reach the network: the client is given the fake's fetch.

let fake: FakePorkbun;
let pb: Porkbun;
let slept: number[];

function client(extra: Partial<ConstructorParameters<typeof Porkbun>[0]> = {}): Porkbun {
	return new Porkbun({
		...fake.credentials,
		baseUrl: fake.baseUrl,
		fetch: fake.fetch,
		sleep: async (ms) => void slept.push(ms),
		...extra
	});
}

beforeEach(() => {
	fake = new FakePorkbun(fakeSeed());
	slept = [];
	pb = client();
});

const last = () => fake.requests[fake.requests.length - 1]!;

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	throw new Error('expected a rejection');
}

describe('transport', () => {
	it('sends the keys as headers on reads and never in a URL', async () => {
		await pb.dns.list('example.com');
		const req = last();
		expect(req.method).toBe('GET');
		expect(req.headers['x-api-key']).toBe(fake.credentials.apiKey);
		expect(req.headers['x-secret-api-key']).toBe(fake.credentials.apiSecret);
		expect(req.rawPath + JSON.stringify(req.query)).not.toContain(fake.credentials.apiKey);
		expect(req.body).toBeUndefined();
	});

	it('sends writes as POST with a JSON body that holds no key and a fresh Idempotency-Key each time', async () => {
		await pb.dns.create('example.com', { host: 'a', type: 'A', content: '203.0.113.1' });
		await pb.dns.create('example.com', { host: 'b', type: 'A', content: '203.0.113.2' });
		const [first, second] = fake.requests;
		for (const req of [first!, second!]) {
			expect(req.method).toBe('POST');
			expect(req.headers['content-type']).toBe('application/json');
			expect(JSON.stringify(req.body)).not.toMatch(/apikey|pk1_|sk1_/i);
			expect(req.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
		}
		expect(first!.headers['idempotency-key']).not.toBe(second!.headers['idempotency-key']);
	});

	it('puts an Idempotency-Key on every POST, dry runs and empty bodies included', async () => {
		await pb.dns.dryRun.delete('example.com', fake.records('example.com')[0]!.id);
		await pb.dns.delete('example.com', fake.records('example.com')[0]!.id);
		await pb.domains.setAutoRenew(['example.com'], false);
		expect(fake.requests.every((r) => r.method === 'POST' && r.headers['idempotency-key'])).toBe(true);
		expect(fake.requests[1]!.body).toEqual({});
	});

	it('reuses a caller-supplied Idempotency-Key, so a retried write is replayed and not repeated', async () => {
		const input = { host: 'once', type: 'A', content: '203.0.113.5' } as const;
		const a = await pb.dns.create('example.com', input, { idempotencyKey: 'retry-1' });
		const b = await pb.dns.create('example.com', input, { idempotencyKey: 'retry-1' });
		expect(b.id).toBe(a.id);
		expect(fake.records('example.com').filter((r) => r.host === 'once')).toHaveLength(1);
	});

	it('URL-encodes every path segment', async () => {
		expect(await pb.dns.get('example.com', '12/../../domain/listAll?x=1#y')).toBeNull();
		expect(last().rawPath).toBe('dns/retrieve/example.com/12%2F..%2F..%2Fdomain%2FlistAll%3Fx%3D1%23y');
		await pb.dns.listByNameType('example.com', 'A', '*');
		expect(last().path).toBe('dns/retrieveByNameType/example.com/A/*');
	});

	it.each(['', '.', '..', 'a\nb'])('refuses the path segment %j before any request', async (segment) => {
		const err = await thrown(() => pb.dns.get('example.com', segment));
		expect(err).toBeInstanceOf(PorkbunError);
		expect((err as PorkbunError).code).toBe('BAD_REQUEST');
		expect(fake.requests).toHaveLength(0);
	});

	it('leaves the last segment out for the apex in the by-name-and-type endpoints', async () => {
		const apex = await pb.dns.listByNameType('example.com', 'A', '');
		expect(last().path).toBe('dns/retrieveByNameType/example.com/A');
		expect(apex.map((r) => r.host)).toEqual(['']);
	});

	it('maps an error body to PorkbunError with code, status, next action, request id and details', async () => {
		fake.scopes = ['read'];
		const err = (await thrown(() =>
			pb.dns.create('example.com', { host: 'x', type: 'A', content: '203.0.113.1' })
		)) as PorkbunError;
		expect(err).toBeInstanceOf(PorkbunError);
		expect(err.code).toBe('INSUFFICIENT_SCOPE');
		expect(err.httpStatus).toBe(403);
		expect(err.retryable).toBe(false);
		expect(err.nextAction).toMatchObject({ type: 'enable_setting', url: 'https://porkbun.com/account/api' });
		expect(err.requestId).toMatch(/^fake-request-/);
		expect(err.details).toEqual({ requiredScope: 'dns', keyScopes: ['read'] });
	});

	it('treats a 200 that says ERROR as a refusal', async () => {
		fake.respondNext({
			status: 200,
			body: { status: 'ERROR', code: 'INVALID_DOMAIN', message: 'Invalid domain.' }
		});
		const err = (await thrown(() => pb.ns.get('example.com'))) as PorkbunError;
		expect(err.code).toBe('INVALID_DOMAIN');
		expect(err.httpStatus).toBe(400);
	});

	it('retries a rate-limited read once after Retry-After', async () => {
		fake.rateLimitNext(2);
		const zone = await pb.dns.list('example.com');
		expect(zone.records.length).toBeGreaterThan(0);
		expect(slept).toEqual([2000]);
		expect(fake.requests).toHaveLength(2);
	});

	it('gives up after one retry', async () => {
		fake.rateLimitNext(1, 2);
		const err = (await thrown(() => pb.dns.list('example.com'))) as PorkbunError;
		expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
		expect(err.retryable).toBe(true);
		expect(err.retryAfter).toBe(1);
		expect(fake.requests).toHaveLength(2);
	});

	it('does not wait out a long Retry-After', async () => {
		fake.rateLimitNext(120);
		const err = (await thrown(() => pb.dns.list('example.com'))) as PorkbunError;
		expect(err.retryAfter).toBe(120);
		expect(slept).toEqual([]);
		expect(fake.requests).toHaveLength(1);
	});

	it('never retries a write', async () => {
		fake.rateLimitNext(1);
		const err = (await thrown(() =>
			pb.dns.create('example.com', { host: 'x', type: 'A', content: '203.0.113.1' })
		)) as PorkbunError;
		expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
		expect(fake.requests).toHaveLength(1);
		expect(slept).toEqual([]);
	});

	it('reports a 429 without a JSON body as a rate limit', async () => {
		fake.respondNext({ status: 429, text: 'slow down', headers: { 'retry-after': '60' } });
		const err = (await thrown(() => pb.ping())) as PorkbunError;
		expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
		expect(err.retryAfter).toBe(60);
	});

	it('reports a dropped connection as unreachable, keeping only the system error code', async () => {
		fake.throwNext(
			new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', message: 'secret detail' } })
		);
		const err = (await thrown(() => pb.ping())) as PorkbunUnreachable;
		expect(err).toBeInstanceOf(PorkbunUnreachable);
		expect(err.reason).toBe('network');
		expect(err.message).toBe('Porkbun could not be reached (ECONNREFUSED)');
	});

	it('reports a timeout as unreachable', async () => {
		const slow = client({
			timeoutMs: 20,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				})
		});
		const err = (await thrown(() => slow.ping())) as PorkbunUnreachable;
		expect(err).toBeInstanceOf(PorkbunUnreachable);
		expect(err.reason).toBe('timeout');
	});

	it('reports a reply that is not JSON as unreachable', async () => {
		fake.respondNext({ status: 502, text: '<html>Bad gateway</html>' });
		const err = (await thrown(() => pb.ping())) as PorkbunUnreachable;
		expect(err).toBeInstanceOf(PorkbunUnreachable);
		expect(err.reason).toBe('bad_response');
		expect(err.message).toBe('Porkbun answered HTTP 502 without JSON');
	});

	it('refuses to follow redirects, which would carry the key headers elsewhere', async () => {
		let seen: RequestInit | undefined;
		const spy = client({
			fetch: (url, init) => {
				seen = init;
				return fake.fetch(url, init);
			}
		});
		await spy.ping();
		expect(seen?.redirect).toBe('error');
	});

	it('runs at most four requests at a time', async () => {
		let active = 0;
		let peak = 0;
		const gated = client({
			fetch: async (url, init) => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return fake.fetch(url, init);
			}
		});
		await Promise.all(Array.from({ length: 12 }, () => gated.ns.get('example.com')));
		expect(peak).toBe(4);
		expect(fake.requests).toHaveLength(12);
	});

	it('remembers the API version Porkbun reports', async () => {
		await pb.ping();
		expect(pb.lastApiVersion).toBe('3.107');
	});

	it('knows a sandbox key by its prefix', () => {
		expect(pb.sandbox).toBe(false);
		expect(client({ apiKey: 'pk1_sb_example' }).sandbox).toBe(true);
	});
});

describe('conversions', () => {
	it('turns Porkbun dates into ISO 8601 UTC', () => {
		expect(isoDate('2027-01-15 10:00:00')).toBe('2027-01-15T10:00:00Z');
		expect(isoDate('2027-01-15')).toBe('2027-01-15T00:00:00Z');
		expect(isoDate('string')).toBe('');
		expect(isoDate('2027-13-45 10:00:00')).toBe('');
		expect(isoDate(null)).toBe('');
	});

	it('splits a record name into its host part', () => {
		expect(hostOf('example.com', 'example.com')).toBe('');
		expect(hostOf('WWW.Example.com.', 'example.com')).toBe('www');
		expect(hostOf('*.example.com', 'example.com')).toBe('*');
		expect(hostOf('a.b.example.com', 'example.com')).toBe('a.b');
		expect(hostOf('notexample.com', 'example.com')).toBe('notexample.com');
	});
});

describe('ping', () => {
	it('returns the public IP, the account and the scopes; "full" means all eight', async () => {
		expect(await pb.ping()).toEqual({
			ip: '203.0.113.10',
			credentialsValid: true,
			account: 'example-account',
			scopes: ['read', 'dns', 'domains', 'email', 'hosting', 'purchase', 'funding', 'account']
		});
		fake.scopes = ['read', 'dns', 'site'];
		expect((await pb.ping()).scopes).toEqual(['read', 'dns']);
	});

	it('fails with the code Porkbun gives for wrong keys', async () => {
		const err = (await thrown(() => client({ apiSecret: 'sk1_wrong' }).ping())) as PorkbunError;
		expect(err.code).toBe('INVALID_API_KEYS_001');
		expect(err.retryable).toBe(false);
	});
});

describe('domains', () => {
	it('lists every domain with flags as booleans and dates as ISO strings', async () => {
		const list = await pb.domains.list();
		expect(list.map((d) => d.domain).sort()).toEqual(['example.com', 'example.net', 'example.org']);
		expect(list.find((d) => d.domain === 'example.com')).toEqual({
			domain: 'example.com',
			tld: 'com',
			status: 'ACTIVE',
			createDate: '2021-01-15T10:00:00Z',
			expireDate: '2027-01-15T10:00:00Z',
			autoRenew: true,
			securityLock: true,
			whoisPrivacy: true,
			apiAccess: true,
			notLocal: false,
			labels: [{ id: '1', title: 'homelab', color: '#f59e0b' }]
		});
		expect(list.find((d) => d.domain === 'example.org')?.apiAccess).toBe(false);
		expect(last().query).toMatchObject({ start: '0', includeLabels: 'yes' });
	});

	it('follows the pages of a large account', async () => {
		const seed = fakeSeed();
		const template = seed.domains[0]!;
		seed.domains = Array.from({ length: 2300 }, (_, i) => ({ ...template, domain: `site-${i}.example` }));
		fake = new FakePorkbun(seed);
		const list = await client().domains.list();
		expect(list).toHaveLength(2300);
		expect(new Set(list.map((d) => d.domain)).size).toBe(2300);
		expect(fake.requests.map((r) => r.query.start)).toEqual(['0', '1000', '2000']);
	});

	it('gets one domain, and a 404 code for one that is not in the account', async () => {
		expect((await pb.domains.get('example.net')).autoRenew).toBe(false);
		const err = (await thrown(() => pb.domains.get('nope.example'))) as PorkbunError;
		expect(err.code).toBe('DOMAIN_NOT_FOUND');
		expect(err.httpStatus).toBe(404);
		expect(err.details).toEqual({ account: 'example-account' });
	});

	it('sets auto-renew for one domain or many and reports per domain', async () => {
		const one = await pb.domains.setAutoRenew(['example.net'], true);
		expect(one.results).toEqual([{ domain: 'example.net', ok: true, message: 'Auto renew is now on.' }]);
		expect(last().path).toBe('domain/updateAutoRenew/example.net');
		expect(last().body).toEqual({ status: 'on' });

		const many = await pb.domains.setAutoRenew(['example.com', 'example.org', 'nope.example'], false);
		expect(last().body).toEqual({ status: 'off', domains: ['example.org', 'nope.example'] });
		expect(many.results).toEqual([
			{ domain: 'example.com', ok: true, message: 'Auto renew is now off.' },
			{ domain: 'example.org', ok: false, message: 'Domain is not opted in to API access.' },
			{ domain: 'nope.example', ok: false, message: 'Invalid domain.' }
		]);
		expect((await pb.domains.get('example.com')).autoRenew).toBe(false);
		expect(await pb.domains.setAutoRenew([], true)).toEqual({ results: [], warnings: [] });
	});
});

describe('dns records', () => {
	it('keeps what Porkbun says along with a zone, and adds nothing when it says nothing', async () => {
		expect(await pb.dns.list('example.com')).not.toHaveProperty('warnings');
		const said = 'example.com is served through Cloudflare, so the records here are not what resolves.';
		fake.respondNext({
			status: 200,
			body: { status: 'SUCCESS', cloudflare: 'enabled', records: [], warnings: [said, 7, null] }
		});
		expect(await pb.dns.list('example.com')).toEqual({ records: [], cloudflare: true, warnings: [said] });
		fake.respondNext({ status: 200, body: { status: 'SUCCESS', records: [], warnings: [] } });
		expect(await pb.dns.list('example.com')).toEqual({ records: [], cloudflare: false });
	});

	it('lists a zone with numbers as numbers and the host split from the name', async () => {
		const zone = await pb.dns.list('example.com');
		expect(zone.cloudflare).toBe(false);
		expect(zone.records).toHaveLength(11);
		expect(zone.records.find((r) => r.type === 'MX')).toMatchObject({
			name: 'example.com',
			host: '',
			content: 'mail.example.com',
			ttl: 600,
			prio: 10,
			notes: null
		});
		expect(zone.records.find((r) => r.host === 'www')).toMatchObject({
			name: 'www.example.com',
			type: 'A',
			prio: null,
			notes: 'served by Caddy'
		});
		expect(zone.records.every((r) => typeof r.id === 'string' && r.id !== '')).toBe(true);
	});

	it('gets a record by id, or null', async () => {
		const [first] = (await pb.dns.list('example.com')).records;
		expect(await pb.dns.get('example.com', first!.id)).toEqual(first);
		expect(await pb.dns.get('example.com', '1')).toBeNull();
	});

	it('lists records by name and type', async () => {
		const records = await pb.dns.listByNameType('example.com', 'TXT', '_acme-challenge');
		expect(records.map((r) => r.content)).toEqual(['fake-acme-challenge-token']);
		expect(last().path).toBe('dns/retrieveByNameType/example.com/TXT/_acme-challenge');
	});

	it('creates a record and returns its id as a string', async () => {
		const res = await pb.dns.create('example.com', {
			host: 'api',
			type: 'A',
			content: '203.0.113.20',
			ttl: 900,
			notes: 'the API'
		});
		expect(last().body).toEqual({
			name: 'api',
			type: 'A',
			content: '203.0.113.20',
			ttl: 900,
			notes: 'the API'
		});
		expect(res.id).toMatch(/^\d+$/);
		expect(res.warnings).toEqual([]);
		expect(res.requestId).toMatch(/^fake-request-/);
		expect(await pb.dns.get('example.com', res.id)).toMatchObject({
			host: 'api',
			ttl: 900,
			notes: 'the API'
		});
	});

	it('passes on the warning for a zone Porkbun does not serve', async () => {
		const res = await pb.dns.create('example.net', { host: 'x', type: 'A', content: '198.51.100.9' });
		expect(res.warnings).toHaveLength(1);
		expect(res.warnings[0]).toContain('does NOT affect what resolves');
	});

	it('reports a duplicate with the existing id and a conflict with the blocking records', async () => {
		const dup = (await thrown(() =>
			pb.dns.create('example.com', { host: 'www', type: 'A', content: '203.0.113.10' })
		)) as PorkbunError;
		expect(dup.code).toBe('DUPLICATE_RECORD');
		const existing = fake.records('example.com').find((r) => r.host === 'www')!;
		expect(dup.details.existingId).toBe(existing.id);

		const conflict = (await thrown(() =>
			pb.dns.create('example.com', { host: 'www', type: 'CNAME', content: 'example.org' })
		)) as PorkbunError;
		expect(conflict.code).toBe('RECORD_CONFLICT');
		expect(conflict.details.conflictingRecords).toEqual([
			expect.objectContaining({ name: 'www.example.com', type: 'A' })
		]);
	});

	it('reports a full zone with its count and limit', async () => {
		fake.recordLimit = 11;
		const err = (await thrown(() =>
			pb.dns.create('example.com', { host: 'more', type: 'A', content: '203.0.113.1' })
		)) as PorkbunError;
		expect(err.code).toBe('ZONE_RECORD_LIMIT');
		expect(err.details).toEqual({ count: 11, limit: 11 });
	});

	it('edits only the fields given, moves a record to the apex with host "" and clears notes with ""', async () => {
		const www = fake.records('example.com').find((r) => r.host === 'www')!;
		await pb.dns.edit('example.com', www.id, { content: '203.0.113.99' });
		expect(last().body).toEqual({ content: '203.0.113.99' });
		expect(await pb.dns.get('example.com', www.id)).toMatchObject({ host: 'www', notes: 'served by Caddy' });

		await pb.dns.edit('example.com', www.id, { notes: '' });
		expect((await pb.dns.get('example.com', www.id))?.notes).toBeNull();

		await pb.dns.edit('example.com', www.id, { host: '' });
		expect(last().body).toEqual({ name: '' });
		expect((await pb.dns.get('example.com', www.id))?.name).toBe('example.com');

		const err = (await thrown(() =>
			pb.dns.edit('example.com', '1', { content: '203.0.113.1' })
		)) as PorkbunError;
		expect(err.code).toBe('INVALID_RECORD_ID');
	});

	it('edits by name and type', async () => {
		await pb.dns.editByNameType('example.com', 'A', 'mail', { content: '203.0.113.26', ttl: 1200 });
		expect(last().path).toBe('dns/editByNameType/example.com/A/mail');
		expect(last().body).toEqual({ content: '203.0.113.26', ttl: 1200 });
		expect(await pb.dns.listByNameType('example.com', 'A', 'mail')).toEqual([
			expect.objectContaining({ content: '203.0.113.26', ttl: 1200 })
		]);
		await pb.dns.editByNameType('example.com', 'TXT', '', { content: 'v=spf1 -all' });
		expect(last().path).toBe('dns/editByNameType/example.com/TXT');
	});

	it('deletes by id and by name and type', async () => {
		const mail = fake.records('example.com').find((r) => r.host === 'mail')!;
		await pb.dns.delete('example.com', mail.id);
		expect(await pb.dns.get('example.com', mail.id)).toBeNull();

		await pb.dns.deleteByNameType('example.com', 'TXT', '_acme-challenge');
		expect(last().path).toBe('dns/deleteByNameType/example.com/TXT/_acme-challenge');
		expect(await pb.dns.listByNameType('example.com', 'TXT', '_acme-challenge')).toEqual([]);
		expect(fake.records('example.com')).toHaveLength(9);
	});

	it('refuses everything on a domain without API access, with what to change', async () => {
		const err = (await thrown(() => pb.dns.list('example.org'))) as PorkbunError;
		expect(err.code).toBe('API_ACCESS_DISABLED');
		expect(err.nextAction?.type).toBe('enable_setting');
	});

	it('rehearses each record write without changing anything', async () => {
		const before = fake.records('example.com');
		const www = before.find((r) => r.host === 'www')!;
		const good = await Promise.all([
			pb.dns.dryRun.create('example.com', { host: 'new', type: 'A', content: '203.0.113.1' }),
			pb.dns.dryRun.edit('example.com', www.id, { content: '203.0.113.2' }),
			pb.dns.dryRun.editByNameType('example.com', 'A', 'mail', { content: '203.0.113.3' }),
			pb.dns.dryRun.delete('example.com', www.id),
			pb.dns.dryRun.deleteByNameType('example.com', 'TXT', '')
		]);
		expect(good).toEqual(Array(5).fill({ wouldSucceed: true, warnings: [] }));
		expect(fake.requests.every((r) => (r.body as { dryRun?: boolean }).dryRun === true)).toBe(true);
		expect(fake.records('example.com')).toEqual(before);
		expect(fake.writes).toHaveLength(0);
	});

	it('turns a refusal of a dry run into wouldSucceed false, and throws a transient failure', async () => {
		const bad = await pb.dns.dryRun.create('example.com', {
			host: 'www',
			type: 'CNAME',
			content: 'example.org'
		});
		expect(bad.wouldSucceed).toBe(false);
		expect(bad.error).toMatchObject({ code: 'RECORD_CONFLICT', retryable: false });
		expect(bad.error?.details?.conflictingRecords).toHaveLength(1);

		fake.respondNext({
			status: 200,
			body: { status: 'SUCCESS', dryRun: true, wouldSucceed: false, message: 'No.' }
		});
		expect(await pb.dns.dryRun.delete('example.com', '1')).toEqual({
			wouldSucceed: false,
			warnings: [],
			error: { code: 'WOULD_FAIL', message: 'No.', retryable: false }
		});

		fake.rateLimitNext(30);
		const err = (await thrown(() => pb.dns.dryRun.delete('example.com', '1'))) as PorkbunError;
		expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
	});
});

describe('dns restore points, preflight and import', () => {
	async function editWww(content: string): Promise<void> {
		const www = fake.records('example.com').find((r) => r.host === 'www')!;
		await pb.dns.edit('example.com', www.id, { content });
	}

	it('lists restore points, newest first', async () => {
		expect(await pb.dns.history('example.com')).toEqual([]);
		await editWww('203.0.113.50');
		const points = await pb.dns.history('example.com');
		expect(points).toEqual([
			{
				id: expect.any(Number),
				takenAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
				reason: 'before-edit',
				source: 'auto',
				recordCount: 11,
				matchesLive: false
			}
		]);
	});

	it('diffs a restore point against the live zone', async () => {
		await editWww('203.0.113.50');
		const [point] = await pb.dns.history('example.com');
		const diff = await pb.dns.diff('example.com', point!.id);
		expect(diff.inSync).toBe(false);
		expect(diff.snapshot).toMatchObject({ id: point!.id, reason: 'before-edit' });
		expect(diff.missing).toEqual([
			{ name: 'www.example.com', type: 'A', content: '203.0.113.10', ttl: 600, prio: null }
		]);
		expect(diff.extra).toEqual([
			{ name: 'www.example.com', type: 'A', content: '203.0.113.50', ttl: 600, prio: null }
		]);

		const err = (await thrown(() => pb.dns.diff('example.com', 1))) as PorkbunError;
		expect(err.code).toBe('RESTORE_POINT_NOT_FOUND');
		expect(err.httpStatus).toBe(404);
	});

	it('rehearses a restore, then restores without and with prune, and can undo it', async () => {
		await editWww('203.0.113.50');
		const [point] = await pb.dns.history('example.com');

		const rehearsal = await pb.dns.restore('example.com', point!.id, { dryRun: true });
		expect(rehearsal).toMatchObject({ dryRun: true, restored: 1, removed: 0, previousStateSavedAs: null });
		expect(last().body).toEqual({ snapshotId: point!.id, prune: false, dryRun: true });
		expect(fake.records('example.com').filter((r) => r.host === 'www')).toHaveLength(1);

		const added = await pb.dns.restore('example.com', point!.id);
		expect(added).toMatchObject({
			dryRun: false,
			restoredFrom: point!.id,
			restored: 1,
			removed: 0,
			failed: []
		});
		expect(added.previousStateSavedAs).toEqual(expect.any(Number));
		expect(
			fake
				.records('example.com')
				.filter((r) => r.host === 'www')
				.map((r) => r.content)
				.sort()
		).toEqual(['203.0.113.10', '203.0.113.50']);

		const pruned = await pb.dns.restore('example.com', point!.id, { prune: true });
		expect(pruned).toMatchObject({ restored: 0, removed: 1 });
		expect((await pb.dns.diff('example.com', point!.id)).inSync).toBe(true);

		// Undo the first restore: back to the state with only the edited record.
		await pb.dns.restore('example.com', added.previousStateSavedAs!, { prune: true });
		expect(
			fake
				.records('example.com')
				.filter((r) => r.host === 'www')
				.map((r) => r.content)
		).toEqual(['203.0.113.50']);
	});

	it('names the records a restore could not recreate', async () => {
		fake.setRecords('example.com', [
			{ name: '', type: 'ALIAS', content: 'example.org' },
			{ name: 'www', type: 'A', content: '203.0.113.10' }
		]);
		await pb.dns.delete('example.com', fake.records('example.com')[0]!.id);
		const [point] = await pb.dns.history('example.com');
		const res = await pb.dns.restore('example.com', point!.id);
		expect(res.restored).toBe(0);
		expect(res.failed).toEqual([{ name: 'example.com', type: 'ALIAS', reason: expect.any(String) }]);
	});

	it('runs the preflight check for an intent', async () => {
		const safe = await pb.dns.preflight('example.com');
		expect(last().query).toEqual({ intent: 'general' });
		expect(safe).toMatchObject({ intent: 'general', safe: true, blockers: [], warnings: [] });
		expect(safe.checks.every((c) => c.ok && c.nextAction === undefined)).toBe(true);

		const move = await pb.dns.preflight('example.net', 'move-nameservers');
		expect(move.safe).toBe(false);
		expect(move.blockers).toEqual(['dnssec-active']);
		expect(move.warnings).toEqual(['nameservers-ours']);
		expect(move.checks.find((c) => c.id === 'dnssec-active')).toMatchObject({
			severity: 'blocker',
			ok: false,
			nextAction: expect.stringContaining('Remove DNSSEC')
		});
	});

	it('scans what the current nameservers publish', async () => {
		const found = await pb.dns.scan('example.net');
		expect(found).toContainEqual({
			host: '',
			type: 'MX',
			content: 'mx.example-dns.net',
			ttl: 3600,
			prio: 10
		});
		expect(found).toContainEqual({ host: 'www', type: 'CNAME', content: 'example.net', ttl: 300 });
	});

	it('imports a list of records: creates, skips what exists and reports what failed', async () => {
		const records = [
			{ host: 'new', type: 'A', content: '203.0.113.77', ttl: 600 },
			{ host: 'www', type: 'A', content: '203.0.113.10' },
			{ host: 'bad', type: 'A', content: 'not-an-ip' },
			{ host: '', type: 'NS', content: 'ns1.example-dns.net' }
		];
		const rehearsal = await pb.dns.import('example.com', records, { dryRun: true });
		expect(rehearsal).toMatchObject({ dryRun: true, created: 1, skipped: 1, failed: 1 });
		expect(fake.records('example.com')).toHaveLength(11);

		const res = await pb.dns.import('example.com', records);
		expect(last().body).toEqual({
			records: [
				{ name: 'new', type: 'A', content: '203.0.113.77', ttl: 600 },
				{ name: 'www', type: 'A', content: '203.0.113.10' },
				{ name: 'bad', type: 'A', content: 'not-an-ip' },
				{ name: '', type: 'NS', content: 'ns1.example-dns.net' }
			]
		});
		expect(res).toMatchObject({ dryRun: false, created: 1, skipped: 1, failed: 1 });
		expect(res.failures).toEqual([expect.objectContaining({ name: 'bad', type: 'A' })]);
		expect(fake.records('example.com')).toHaveLength(12);
	});

	it('imports whatever a scan discovers when asked to', async () => {
		const res = await pb.dns.import('example.net', 'scan');
		expect(last().body).toEqual({});
		expect(res).toMatchObject({ created: 1, skipped: 2, failed: 0 });
		expect(res.warnings).toHaveLength(1);
	});
});

describe('dnssec', () => {
	it('lists, creates and deletes DS records', async () => {
		expect(await pb.dnssec.list('example.com')).toEqual([]);
		expect(await pb.dnssec.list('example.net')).toEqual([
			{ keyTag: '2371', alg: '13', digestType: '2', digest: expect.stringMatching(/^[0-9A-F]{64}$/) }
		]);

		const input = { keyTag: '4242', alg: '13', digestType: '2', digest: 'ABCDEF0123456789' };
		expect((await pb.dnssec.create('example.com', input)).warnings).toEqual([]);
		expect(last().path).toBe('dns/createDnssecRecord/example.com');
		expect(last().body).toEqual(input);
		expect(await pb.dnssec.list('example.com')).toEqual([input]);

		await pb.dnssec.delete('example.com', '4242');
		expect(last().path).toBe('dns/deleteDnssecRecord/example.com/4242');
		expect(await pb.dnssec.list('example.com')).toEqual([]);
	});

	it('passes on a retirement warning and refuses a deprecated algorithm', async () => {
		const res = await pb.dnssec.create('example.com', {
			keyTag: '1',
			alg: '13',
			digestType: '1',
			digest: 'AB'
		});
		expect(res.warnings).toEqual([expect.stringContaining('being retired')]);
		const err = (await thrown(() =>
			pb.dnssec.create('example.com', { keyTag: '2', alg: '5', digestType: '2', digest: 'AB' })
		)) as PorkbunError;
		expect(err.code).toBe('DNSSEC_ALGORITHM_DEPRECATED');
	});

	it('needs the domains scope to change DNSSEC', async () => {
		fake.scopes = ['read', 'dns'];
		const err = (await thrown(() => pb.dnssec.delete('example.net', '2371'))) as PorkbunError;
		expect(err.code).toBe('INSUFFICIENT_SCOPE');
		expect(err.details.requiredScope).toBe('domains');
	});
});

describe('nameservers', () => {
	it('reads them as a sorted, lower-case set', async () => {
		fake.setDomain('example.net', { ns: ['NS2.Example-DNS.net.', 'ns1.example-dns.net'] });
		expect(await pb.ns.get('example.net')).toEqual(['ns1.example-dns.net', 'ns2.example-dns.net']);
	});

	it('rehearses and applies an update', async () => {
		const next = ['ns1.example-dns.net', 'ns2.example-dns.net'];
		expect(await pb.ns.dryRunUpdate('example.com', next)).toEqual({ wouldSucceed: true, warnings: [] });
		expect(last().body).toEqual({ ns: next, dryRun: true });
		expect((await pb.ns.get('example.com'))[0]).toBe('curitiba.ns.porkbun.com');

		await pb.ns.update('example.com', next);
		expect(last().path).toBe('domain/updateNs/example.com');
		expect(last().body).toEqual({ ns: next });
		expect(await pb.ns.get('example.com')).toEqual(next);

		const bad = await pb.ns.dryRunUpdate('example.com', ['only-one.example']);
		expect(bad).toMatchObject({ wouldSucceed: false, error: { code: 'INVALID_INPUT' } });
	});
});

describe('glue', () => {
	it('lists, creates, updates and deletes glue hosts', async () => {
		expect(await pb.glue.list('example.com')).toEqual([
			{ host: 'ns1.example.com', v4: ['192.0.2.1'], v6: ['2001:db8::1'] }
		]);
		await pb.glue.create('example.com', 'ns2', ['192.0.2.2', '2001:db8::2']);
		expect(last().path).toBe('domain/createGlue/example.com/ns2');
		expect(last().body).toEqual({ ips: ['192.0.2.2', '2001:db8::2'] });

		await pb.glue.update('example.com', 'ns2', ['192.0.2.3']);
		expect(last().path).toBe('domain/updateGlue/example.com/ns2');
		expect(await pb.glue.list('example.com')).toContainEqual({
			host: 'ns2.example.com',
			v4: ['192.0.2.3'],
			v6: []
		});

		await pb.glue.delete('example.com', 'ns2');
		expect(last().path).toBe('domain/deleteGlue/example.com/ns2');
		expect(await pb.glue.list('example.com')).toHaveLength(1);
	});

	it('reads the older hosts shape when glue is absent', async () => {
		fake.respondNext({
			status: 200,
			body: { status: 'SUCCESS', hosts: [['NS1.example.com', { v4: ['192.0.2.1'], v6: [] }], ['bad']] }
		});
		expect(await pb.glue.list('example.com')).toEqual([
			{ host: 'ns1.example.com', v4: ['192.0.2.1'], v6: [] },
			{ host: 'bad', v4: [], v6: [] }
		]);
	});
});

describe('url forwarding', () => {
	it('lists, adds and deletes forwards, keeping 302 and 307 apart', async () => {
		const [existing] = await pb.forwards.list('example.com');
		expect(existing).toEqual({
			id: expect.any(String),
			subdomain: 'old',
			location: 'https://www.example.com',
			redirectType: '301',
			includePath: true,
			wildcard: false
		});

		await pb.forwards.add('example.com', {
			subdomain: 'go',
			location: 'https://example.org/landing',
			redirectType: '307',
			includePath: false,
			wildcard: true
		});
		expect(last().path).toBe('domain/addUrlForward/example.com');
		expect(last().body).toEqual({
			subdomain: 'go',
			location: 'https://example.org/landing',
			type: 'temporary',
			redirectType: '307',
			includePath: 'no',
			wildcard: 'yes'
		});
		const list = await pb.forwards.list('example.com');
		const added = list.find((f) => f.subdomain === 'go')!;
		expect(added).toMatchObject({ redirectType: '307', includePath: false, wildcard: true });

		await pb.forwards.delete('example.com', added.id);
		expect(last().path).toBe(`domain/deleteUrlForward/example.com/${added.id}`);
		expect(await pb.forwards.list('example.com')).toHaveLength(1);
	});

	it('falls back to the coarse type when redirectType is absent', async () => {
		fake.respondNext({
			status: 200,
			body: {
				status: 'SUCCESS',
				forwards: [
					{
						id: '1',
						subdomain: '',
						location: 'https://a.example',
						type: 'permanent',
						includePath: 'no',
						wildcard: 'no'
					},
					{
						id: '2',
						subdomain: '',
						location: 'https://b.example',
						type: 'temporary',
						includePath: 'no',
						wildcard: 'no'
					},
					{
						id: '3',
						subdomain: '',
						location: 'https://c.example',
						type: 'masked',
						includePath: 'no',
						wildcard: 'no'
					}
				]
			}
		});
		expect((await pb.forwards.list('example.com')).map((f) => f.redirectType)).toEqual([
			'301',
			'302',
			'masked'
		]);
	});
});

describe('ssl bundle', () => {
	it('retrieves the certificate chain and keys', async () => {
		const bundle = await pb.ssl.retrieve('example.com');
		expect(last().method).toBe('GET');
		expect(last().path).toBe('ssl/retrieve/example.com');
		expect(bundle.certificateChain).toContain('BEGIN CERTIFICATE');
		expect(bundle.privateKey).toContain('fake private key for example.com');
		expect(bundle.publicKey).toContain('fake public key for example.com');
	});

	it('fails when no certificate has been issued', async () => {
		expect(await thrown(() => pb.ssl.retrieve('example.net'))).toBeInstanceOf(PorkbunError);
	});
});

describe('pricing and account', () => {
	it('gets pricing without sending the keys', async () => {
		const all = await pb.pricing.get();
		expect(last().headers['x-api-key']).toBeUndefined();
		expect(last().headers['x-secret-api-key']).toBeUndefined();
		expect(all.com).toEqual({ registration: '11.08', renewal: '11.08', transfer: '11.08' });

		const some = await pb.pricing.get(['org', 'nope']);
		expect(last().query).toEqual({ tlds: 'org,nope' });
		expect(Object.keys(some)).toEqual(['org']);
	});

	it('reads the account balance', async () => {
		expect(await pb.account.balance()).toEqual({ cents: 2500, display: '$25.00' });
	});

	it('reads the API spend settings', async () => {
		expect(await pb.account.apiSettings()).toEqual({
			monthlySpendLimit: null,
			lowBalanceAlert: null,
			autoTopup: false,
			monthlySpend: 0,
			spendLimit: { limit: 10000, source: 'default', spent: 0, remaining: 10000 }
		});
	});
});
