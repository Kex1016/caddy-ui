import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DNS_RECORD_TYPES, type DnsRecord, type DnsRecordType } from '$lib/api/porkbun';
import { RECORD_KINDS } from '$lib/porkbun/records/kinds';
import { SAMPLES } from '$lib/porkbun/records/samples';
import type { BatchResult, ImportReview, Preview, RecordChange } from '$lib/porkbun/records/types';
import { snapshotOf } from '$lib/porkbun/records/validate';
import { auditLog, porkbunStatus } from '$lib/server/porkbun';
import { resetPorkbunForTests, useFakePorkbun, type FakeContext } from '$lib/server/porkbun/testing';
import { DELETE, PUT } from './[id]/+server';
import { GET, POST } from './+server';
import { POST as batchRoute } from './batch/+server';
import { GET as exportRoute } from './export/+server';
import { POST as importRoute } from './import/+server';
import { POST as previewRoute } from './preview/+server';

let ctx: FakeContext;
beforeEach(() => {
	ctx = useFakePorkbun();
});
afterEach(resetPorkbunForTests);

const D = 'example.com';
const BASE = `/api/porkbun/domains/${D}/dns`;

type Handler = (event: never) => Response | Promise<Response>;

/** Call a route handler the way SvelteKit would. */
async function call(
	handler: Handler,
	method: string,
	path: string,
	body?: unknown,
	params: Record<string, string> = {}
): Promise<{ status: number; body: never; res: Response }> {
	const url = new URL(`http://localhost${path}`);
	const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
	if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
	const res = await handler({
		url,
		params: { domain: D, ...params },
		locals: { identity: { user: 'david', via: 'open' } },
		request: new Request(url, init)
	} as never);
	const text = await res.clone().text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// not JSON: the export
	}
	return { status: res.status, body: parsed as never, res };
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	throw new Error('expected a throw');
}

async function zone(domain = D): Promise<DnsRecord[]> {
	const { body } = await call(GET, 'GET', `/api/porkbun/domains/${domain}/dns?force`, undefined, { domain });
	return (body as { data: { records: DnsRecord[] } }).data.records;
}

const find = async (host: string, type: string) => {
	const found = (await zone()).find((r) => r.host === host && r.type === type);
	if (!found) throw new Error(`no ${type} record at ${host || 'the apex'}`);
	return found;
};

const batch = (changes: RecordChange[], extra: object = {}) =>
	call(batchRoute, 'POST', `${BASE}/batch`, { changes, ...extra }) as Promise<{
		status: number;
		body: BatchResult;
		res: Response;
	}>;

const preview = (changes: RecordChange[]) =>
	call(previewRoute, 'POST', `${BASE}/preview`, { changes }) as Promise<{
		status: number;
		body: Preview;
		res: Response;
	}>;

const importCall = (body: object) =>
	call(importRoute, 'POST', `${BASE}/import`, body) as Promise<{
		status: number;
		body: ImportReview;
		res: Response;
	}>;

const writesSoFar = () => ctx.fake.writes.length;

describe('GET …/dns', () => {
	it('lists the zone from the cache, and again from Porkbun when forced', async () => {
		const first = await call(GET, 'GET', BASE);
		expect(first.status).toBe(200);
		expect(first.res.headers.get('cache-control')).toBe('no-store');
		const body = first.body as { data: { records: DnsRecord[]; cloudflare: boolean }; stale: boolean };
		expect(body.stale).toBe(false);
		expect(body.data.records).toHaveLength(11);
		expect(body.data.records[0]).toMatchObject({
			name: D,
			host: '',
			type: 'A',
			content: '203.0.113.10',
			ttl: 600
		});
		const reads = () => ctx.fake.requests.filter((r) => r.path === `dns/retrieve/${D}`).length;
		await call(GET, 'GET', BASE);
		expect(reads()).toBe(1);
		await call(GET, 'GET', `${BASE}?force`);
		expect(reads()).toBe(2);
	});

	it('is a 404 for a domain that is not in the account, without asking Porkbun about it', async () => {
		const err = await thrown(() =>
			call(GET, 'GET', '/api/porkbun/domains/nope.example/dns', undefined, { domain: 'nope.example' })
		);
		if (!isHttpError(err)) throw new Error('expected an HttpError');
		expect(err.status).toBe(404);
		expect(ctx.fake.requests.some((r) => r.path.includes('nope.example'))).toBe(false);
	});

	it('passes on why a zone can not be read', async () => {
		const res = await call(GET, 'GET', '/api/porkbun/domains/example.org/dns', undefined, {
			domain: 'example.org'
		});
		expect(res.status).toBe(422);
		expect(res.body).toMatchObject({ code: 'API_ACCESS_DISABLED' });
	});
});

describe('each of the 14 record types', () => {
	describe.each(DNS_RECORD_TYPES)('%s', (type: DnsRecordType) => {
		const sample = SAMPLES[type];
		const record = (content: string) => ({
			host: sample.host,
			type,
			content,
			...(sample.prio !== undefined ? { prio: sample.prio } : {})
		});

		it('is created, edited and deleted', async () => {
			const created = await call(POST, 'POST', BASE, {
				...record(sample.content),
				ttl: 1800,
				notes: 'made by a test'
			});
			expect(created.status).toBe(200);
			const { id } = (created.body as { ok: true; data: { id: string } }).data;
			expect(id).toMatch(/^\d+$/);
			expect(created.body).toMatchObject({ ok: true, warnings: [] });

			let live = await find(sample.host, type);
			expect(live).toMatchObject({
				id,
				content: sample.content,
				ttl: 1800,
				notes: 'made by a test',
				prio: RECORD_KINDS[type].usesPrio ? (sample.prio ?? 0) : null
			});

			const edited = await call(
				PUT,
				'PUT',
				`${BASE}/${id}`,
				{ record: { ...record(sample.edited), notes: '' }, expect: snapshotOf(live) },
				{ id }
			);
			expect(edited.status).toBe(200);
			expect(edited.body).toMatchObject({ ok: true, data: { id } });
			live = await find(sample.host, type);
			// The TTL was not sent, so it stays; empty notes clear the notes.
			expect(live).toMatchObject({ id, content: sample.edited, ttl: 1800, notes: null });
			const editRequest = ctx.fake.writes.at(-1);
			expect(editRequest?.path).toBe(`dns/edit/${D}/${id}`);
			expect(editRequest?.body).toEqual({ content: sample.edited, notes: '' });

			const deleted = await call(DELETE, 'DELETE', `${BASE}/${id}`, { expect: snapshotOf(live) }, { id });
			expect(deleted.status).toBe(200);
			expect(deleted.body).toMatchObject({ ok: true, data: { id } });
			expect((await zone()).some((r) => r.id === id)).toBe(false);

			// All three are in the write log, the edit and the delete with what they replaced.
			const log = auditLog({ domain: D }).entries;
			expect(log.map((e) => e.action)).toEqual(['dns.delete', 'dns.edit', 'dns.create']);
			expect(log.every((e) => e.ok && e.author === 'david')).toBe(true);
			expect(log[0]?.before).toMatchObject({ content: sample.edited });
			expect(log[1]?.before).toMatchObject({ content: sample.content, notes: 'made by a test' });
		});

		it('is refused before any call when the value is not valid', async () => {
			await porkbunStatus();
			const before = ctx.fake.requests.length;
			const res = await call(POST, 'POST', BASE, record(sample.invalid));
			expect(res.status).toBe(400);
			expect(res.body).toMatchObject({ code: 'INVALID_RECORD' });
			expect((res.body as { fields: unknown[] }).fields.length).toBeGreaterThan(0);
			expect(writesSoFar()).toBe(0);
			// One read of the zone at most; nothing about the record itself went out.
			expect(ctx.fake.requests.slice(before).every((r) => r.method === 'GET')).toBe(true);
			expect(auditLog().entries).toHaveLength(0);
		});
	});
});

describe('POST …/dns', () => {
	it('adopts the existing record when Porkbun says it is a duplicate', async () => {
		const real = await find('', 'MX');
		await porkbunStatus();
		// Someone adds the same record elsewhere between this UI's read of the zone and its write: the plan
		// sees a zone without it, so only Porkbun can notice the twin.
		ctx.fake.respondNext({ status: 200, body: { status: 'SUCCESS', records: [] } });
		const res = await call(POST, 'POST', BASE, {
			host: '',
			type: 'MX',
			content: 'mail.example.com',
			prio: 10
		});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, data: { id: real.id, adopted: true } });
		expect((res.body as { warnings: string[] }).warnings[0]).toMatch(/already there, so nothing was created/);
		expect((await zone()).filter((r) => r.type === 'MX')).toHaveLength(1);
		// Porkbun's refusal is in the write log as what it was.
		expect(auditLog().entries[0]).toMatchObject({ action: 'dns.create', ok: false });
	});

	it('refuses a record that clashes with the zone, with a 409 and nothing sent', async () => {
		const dup = await call(POST, 'POST', BASE, { host: 'www', type: 'A', content: '203.0.113.10' });
		expect(dup.status).toBe(409);
		expect(dup.body).toMatchObject({ code: 'PLAN_REFUSED' });
		expect((dup.body as { message: string }).message).toMatch(
			/Nothing was changed\. There is already an A record/
		);

		const cname = await call(POST, 'POST', BASE, {
			host: 'www',
			type: 'CNAME',
			content: 'target.example.net'
		});
		expect(cname.status).toBe(409);
		expect((cname.body as { items: { problems: { code: string }[] }[] }).items[0]?.problems[0]?.code).toBe(
			'CNAME_CONFLICT'
		);
		expect(writesSoFar()).toBe(0);
	});

	it('answers 400 for a body that is not JSON or not a record', async () => {
		expect((await call(POST, 'POST', BASE, '{ nope')).status).toBe(400);
		expect((await call(POST, 'POST', BASE, '[]')).status).toBe(400);
		expect(
			(await call(POST, 'POST', BASE, { host: 'a', type: 'PTR', content: 'x.example.com' })).status
		).toBe(400);
		expect(writesSoFar()).toBe(0);
	});

	it("shows Porkbun's warning as written when the zone is not served by Porkbun", async () => {
		const res = await call(
			POST,
			'POST',
			'/api/porkbun/domains/example.net/dns',
			{ host: 'app', type: 'A', content: '198.51.100.9' },
			{ domain: 'example.net' }
		);
		expect(res.status).toBe(200);
		expect((res.body as { warnings: string[] }).warnings[0]).toMatch(
			/example\.net is delegated to nameservers we do not operate/
		);
	});

	it("answers 502 with Porkbun's reason when Porkbun refuses the write", async () => {
		ctx.fake.recordLimit = 11;
		const res = await call(POST, 'POST', BASE, { host: 'full', type: 'A', content: '198.51.100.9' });
		expect(res.status).toBe(502);
		expect(res.body).toMatchObject({
			ok: false,
			error: { code: 'ZONE_RECORD_LIMIT', details: { count: 11, limit: 11 } }
		});
		expect(auditLog().entries[0]).toMatchObject({ action: 'dns.create', ok: false });
	});
});

describe('PUT and DELETE …/dns/:id', () => {
	it('refuses to overwrite a record that was changed somewhere else', async () => {
		const www = await find('www', 'A');
		const seen = snapshotOf(www);
		// Somebody else changes it at porkbun.com.
		ctx.fake.setRecords(
			D,
			ctx.fake.records(D).map((r) => ({
				name: r.host,
				type: r.type,
				content: r.host === 'www' ? '203.0.113.77' : r.content,
				ttl: r.ttl,
				...(r.prio !== null ? { prio: r.prio } : {})
			}))
		);
		const moved = await find('www', 'A');
		const res = await call(
			PUT,
			'PUT',
			`${BASE}/${moved.id}`,
			{ record: { host: 'www', type: 'A', content: '203.0.113.11' }, expect: seen },
			{ id: moved.id }
		);
		expect(res.status).toBe(409);
		expect((res.body as { message: string }).message).toMatch(/changed somewhere else.*203\.0\.113\.77/);
		const del = await call(DELETE, 'DELETE', `${BASE}/${moved.id}`, { expect: seen }, { id: moved.id });
		expect(del.status).toBe(409);
		expect(writesSoFar()).toBe(0);
	});

	it('answers 409 for a record that is gone and 404 for an id that is not one', async () => {
		const gone = await call(DELETE, 'DELETE', `${BASE}/424242`, undefined, { id: '424242' });
		expect(gone.status).toBe(409);
		expect((gone.body as { message: string }).message).toMatch(/no longer in the zone/);
		const bad = await call(DELETE, 'DELETE', `${BASE}/..%2Fx`, undefined, { id: '../x' });
		expect(bad.status).toBe(404);
		expect(writesSoFar()).toBe(0);
	});

	it('sends nothing when an edit changes nothing', async () => {
		const www = await find('www', 'A');
		const res = await call(
			PUT,
			'PUT',
			`${BASE}/${www.id}`,
			{ record: { host: 'www', type: 'A', content: '203.0.113.10', ttl: 600, notes: 'served by Caddy' } },
			{ id: www.id }
		);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, data: { id: www.id } });
		expect(writesSoFar()).toBe(0);
	});

	it('does not change the type of a record or touch a type it does not know', async () => {
		const www = await find('www', 'A');
		const retype = await call(
			PUT,
			'PUT',
			`${BASE}/${www.id}`,
			{ record: { host: 'www', type: 'AAAA', content: '2001:db8::1' } },
			{ id: www.id }
		);
		expect(retype.status).toBe(409);
		expect((retype.body as { message: string }).message).toMatch(/type of a record can not be changed/);

		ctx.fake.setRecords(D, [{ name: 'odd', type: 'LOC', content: '52 22 23.000 N 4 53 32.000 E -2.00m' }]);
		const odd = (await zone())[0] as DnsRecord;
		expect(odd.type).toBe('LOC');
		const del = await call(DELETE, 'DELETE', `${BASE}/${odd.id}`, undefined, { id: odd.id });
		expect(del.status).toBe(409);
		expect((del.body as { message: string }).message).toMatch(
			/LOC is a record type this version of Caddy UI can only show/
		);
		expect(writesSoFar()).toBe(0);
	});

	it('moves a record to the apex and to another name', async () => {
		const mail = await find('mail', 'A');
		await call(
			PUT,
			'PUT',
			`${BASE}/${mail.id}`,
			{ record: { host: 'smtp', type: 'A', content: mail.content } },
			{ id: mail.id }
		);
		expect(ctx.fake.writes.at(-1)?.body).toEqual({ name: 'smtp' });
		expect((await zone()).find((r) => r.id === mail.id)).toMatchObject({
			host: 'smtp',
			name: 'smtp.example.com'
		});
		await call(
			PUT,
			'PUT',
			`${BASE}/${mail.id}`,
			{ record: { host: '@', type: 'A', content: mail.content } },
			{ id: mail.id }
		);
		expect(ctx.fake.writes.at(-1)?.body).toEqual({ name: '' });
		expect((await zone()).find((r) => r.id === mail.id)).toMatchObject({ host: '', name: D });
	});
});

describe('read-only mode and key permissions', () => {
	const tryAll = async () => {
		const www = ctx.fake.records(D).find((r) => r.host === 'www') as { id: string };
		const record = { host: 'new', type: 'A', content: '198.51.100.1' };
		const changes: RecordChange[] = [{ op: 'create', record: record as never }];
		return Promise.all([
			thrown(() => call(POST, 'POST', BASE, record)),
			thrown(() => call(PUT, 'PUT', `${BASE}/${www.id}`, { record }, { id: www.id })),
			thrown(() => call(DELETE, 'DELETE', `${BASE}/${www.id}`, undefined, { id: www.id })),
			thrown(() => call(previewRoute, 'POST', `${BASE}/preview`, { changes })),
			thrown(() => call(batchRoute, 'POST', `${BASE}/batch`, { changes })),
			thrown(() =>
				call(importRoute, 'POST', `${BASE}/import`, { text: 'new IN A 198.51.100.1', dryRun: true })
			),
			thrown(() => call(importRoute, 'POST', `${BASE}/import`, { scan: true, dryRun: true }))
		]);
	};

	it('refuses every write and every rehearsal with a 403 in read-only mode, and still reads and exports', async () => {
		ctx = useFakePorkbun({ settings: { readonly: true } });
		for (const err of await tryAll()) {
			if (!isHttpError(err)) throw new Error('expected an HttpError');
			expect(err.status).toBe(403);
			expect(err.body).toMatchObject({ code: 'READ_ONLY' });
		}
		expect(ctx.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
		expect((await call(GET, 'GET', BASE)).status).toBe(200);
		expect((await call(exportRoute, 'GET', `${BASE}/export`)).status).toBe(200);
	});

	it('refuses them when the key lacks the dns permission', async () => {
		ctx.fake.scopes = ['read', 'domains'];
		for (const err of await tryAll()) {
			if (!isHttpError(err)) throw new Error('expected an HttpError');
			expect(err.status).toBe(403);
			expect(err.body).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
		}
		expect(ctx.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
	});
});

describe('POST …/dns/preview', () => {
	it("gives before and after for every change and Porkbun's dry run, and changes nothing", async () => {
		const www = await find('www', 'A');
		const mx = await find('', 'MX');
		const res = await preview([
			{ op: 'create', record: { host: 'new', type: 'A', content: '198.51.100.1', ttl: 60 } },
			{
				op: 'edit',
				id: www.id,
				record: { host: 'www', type: 'A', content: '203.0.113.11' },
				expect: snapshotOf(www)
			},
			{ op: 'delete', id: mx.id, expect: snapshotOf(mx) }
		]);
		expect(res.status).toBe(200);
		expect(res.body.wouldSucceed).toBe(true);
		expect(res.body.confirm).toBe(false);
		expect(res.body.items.map((i) => [i.op, i.name, i.dryRun?.wouldSucceed])).toEqual([
			['create', 'new.example.com', true],
			['edit', 'www.example.com', true],
			['delete', 'example.com', true]
		]);
		expect(res.body.items[0]?.advice.join(' ')).toMatch(/raises a TTL/);
		expect(res.body.items[1]).toMatchObject({
			before: { content: '203.0.113.10' },
			after: { content: '203.0.113.11' },
			changed: ['content']
		});
		// Three dry runs went to Porkbun, each marked as one; nothing was written or logged.
		const posts = ctx.fake.requests.filter((r) => r.method === 'POST');
		expect(posts.map((r) => (r.body as { dryRun?: boolean }).dryRun)).toEqual([true, true, true]);
		expect(writesSoFar()).toBe(0);
		expect(auditLog().entries).toHaveLength(0);
		expect(await zone()).toHaveLength(11);
	});

	it('does not ask Porkbun about a change that only works after an earlier one', async () => {
		const www = await find('www', 'A');
		const res = await preview([
			{ op: 'delete', id: www.id },
			{ op: 'create', record: { host: 'www', type: 'CNAME', content: 'target.example.net' } }
		]);
		expect(res.body.wouldSucceed).toBe(true);
		expect(res.body.items.map((i) => [i.needsEarlier, i.dryRun === null])).toEqual([
			[false, false],
			[true, true]
		]);
		expect(ctx.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
	});

	it('reports a problem without asking Porkbun about anything', async () => {
		const res = await preview([
			{ op: 'create', record: { host: 'fine', type: 'A', content: '198.51.100.1' } },
			{ op: 'create', record: { host: 'blog', type: 'A', content: '198.51.100.1' } }
		]);
		expect(res.status).toBe(200);
		expect(res.body.wouldSucceed).toBe(false);
		expect(res.body.items[1]?.problems[0]?.code).toBe('CNAME_CONFLICT');
		expect(res.body.items.every((i) => i.dryRun === null)).toBe(true);
		expect(ctx.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
	});

	it("passes on what Porkbun's dry run refuses", async () => {
		// A full zone is something only Porkbun knows.
		ctx.fake.recordLimit = 11;
		const res = await preview([
			{ op: 'create', record: { host: 'new', type: 'A', content: '198.51.100.1' } }
		]);
		expect(res.body.wouldSucceed).toBe(false);
		expect(res.body.items[0]?.dryRun).toMatchObject({
			wouldSucceed: false,
			error: { code: 'ZONE_RECORD_LIMIT' }
		});
	});

	it('asks for the typed domain name when more than one record is deleted', async () => {
		const [a, b] = await zone();
		const res = await preview([
			{ op: 'delete', id: (a as DnsRecord).id },
			{ op: 'delete', id: (b as DnsRecord).id }
		]);
		expect(res.body.confirm).toBe(true);
	});

	it('answers 400 for an invalid record and for a list that is not one', async () => {
		const invalid = await call(previewRoute, 'POST', `${BASE}/preview`, {
			changes: [
				{ op: 'create', record: { host: 'ok', type: 'A', content: '198.51.100.1' } },
				{ op: 'create', record: { host: 'bad', type: 'A', content: 'nope' } }
			]
		});
		expect(invalid.status).toBe(400);
		expect(invalid.body).toMatchObject({ code: 'INVALID_RECORD', index: 1 });
		expect((invalid.body as { message: string }).message).toMatch(/^Change 2 is not a valid record/);
		for (const body of [
			{},
			{ changes: [] },
			{ changes: [{ op: 'nope' }] },
			{ changes: [{ op: 'delete' }] }
		]) {
			expect((await call(previewRoute, 'POST', `${BASE}/preview`, body)).status).toBe(400);
		}
		const tooMany = { changes: Array.from({ length: 101 }, () => ({ op: 'delete', id: '1' })) };
		const res = await call(previewRoute, 'POST', `${BASE}/preview`, tooMany);
		expect(res.status).toBe(400);
		expect((res.body as { message: string }).message).toMatch(/at most 100 changes/);
	});

	it('answers 429 when Porkbun rate limits the dry run, and 503 when it can not be reached', async () => {
		await zone();
		// The fresh read of the zone goes through; the dry run is rate limited.
		const changes: RecordChange[] = [
			{ op: 'create', record: { host: 'new', type: 'A', content: '198.51.100.1' } }
		];
		await porkbunStatus();
		ctx.fake.respondNext({ status: 200, body: { status: 'SUCCESS', records: [] } });
		ctx.fake.rateLimitNext(30);
		const limited = await preview(changes);
		expect(limited.status).toBe(429);
		expect(limited.res.headers.get('retry-after')).toBe('30');

		ctx.fake.throwNext(new TypeError('fetch failed'));
		const down = await preview(changes);
		expect(down.status).toBe(503);
		expect((down.body as never as { message: string }).message).toMatch(
			/could not be read and nothing was changed/
		);
	});
});

describe('POST …/dns/batch', () => {
	it('applies a mixed batch in order', async () => {
		const www = await find('www', 'A');
		const blog = await find('blog', 'CNAME');
		const mx = await find('', 'MX');
		const res = await batch([
			{ op: 'delete', id: www.id, expect: snapshotOf(www) },
			{ op: 'create', record: { host: 'www', type: 'CNAME', content: 'target.example.net', notes: 'moved' } },
			{ op: 'edit', id: mx.id, record: { host: '', type: 'MX', content: 'mail.example.com', prio: 5 } },
			{ op: 'edit', id: blog.id, record: { host: 'blog', type: 'CNAME', content: 'example.org', ttl: 3600 } }
		]);
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.items.map((i) => i.status)).toEqual(['applied', 'applied', 'applied', 'unchanged']);
		expect(res.body.counts).toEqual({ applied: 3, unchanged: 1, adopted: 0, failed: 0, not_applied: 0 });
		// In order: the A record had to go before the CNAME could exist.
		expect(ctx.fake.writes.map((r) => r.path.split('/').slice(0, 2).join('/'))).toEqual([
			'dns/delete',
			'dns/create',
			'dns/edit'
		]);
		const after = await zone();
		expect(after.find((r) => r.host === 'www')).toMatchObject({
			type: 'CNAME',
			content: 'target.example.net',
			notes: 'moved'
		});
		expect(after.find((r) => r.type === 'MX')).toMatchObject({ prio: 5 });
		expect(auditLog().entries.map((e) => e.action)).toEqual(['dns.edit', 'dns.create', 'dns.delete']);
	});

	it('stops at the first failure and says what was applied, what failed and what was not sent', async () => {
		const www = await find('www', 'A');
		const mail = await find('mail', 'A');
		const changes: RecordChange[] = [
			{ op: 'create', record: { host: 'one', type: 'A', content: '198.51.100.1' } },
			{ op: 'create', record: { host: 'two', type: 'A', content: '198.51.100.2' } },
			{ op: 'edit', id: www.id, record: { host: 'www', type: 'A', content: '203.0.113.11' } },
			{ op: 'delete', id: mail.id }
		];
		// Room for exactly one more record: the second create is refused by Porkbun.
		ctx.fake.recordLimit = 12;
		const res = await batch(changes);
		expect(res.status).toBe(207);
		expect(res.body.ok).toBe(false);
		expect(res.body.items.map((i) => [i.index, i.status, i.name])).toEqual([
			[0, 'applied', 'one.example.com'],
			[1, 'failed', 'two.example.com'],
			[2, 'not_applied', 'www.example.com'],
			[3, 'not_applied', 'mail.example.com']
		]);
		expect(res.body.items[1]?.error).toMatchObject({ code: 'ZONE_RECORD_LIMIT' });
		expect(res.body.counts).toEqual({ applied: 1, unchanged: 0, adopted: 0, failed: 1, not_applied: 2 });
		// The zone has the first change and none of the later ones.
		const after = await zone();
		expect(after.some((r) => r.host === 'one')).toBe(true);
		expect(after.some((r) => r.host === 'two')).toBe(false);
		expect(after.find((r) => r.id === www.id)?.content).toBe('203.0.113.10');
		expect(after.some((r) => r.id === mail.id)).toBe(true);
		expect(ctx.fake.writes).toHaveLength(2);
		// Both attempts are in the write log, the failed one as failed.
		expect(auditLog().entries.map((e) => [e.action, e.ok])).toEqual([
			['dns.create', false],
			['dns.create', true]
		]);
	});

	it('stops when the connection drops, since that write may or may not have happened', async () => {
		const www = await find('www', 'A');
		await porkbunStatus();
		const changes: RecordChange[] = [
			{ op: 'edit', id: www.id, record: { host: 'www', type: 'A', content: '203.0.113.11' } },
			{ op: 'create', record: { host: 'after', type: 'A', content: '198.51.100.1' } }
		];
		// The fresh read succeeds, then the first write is lost.
		const real = ctx.fake.fetch;
		let n = 0;
		const flaky: typeof real = (input, init) => {
			if (init?.method === 'POST' && n++ === 0) return Promise.reject(new TypeError('fetch failed'));
			return real(input, init);
		};
		ctx = useFakePorkbun();
		const { configurePorkbunForTests } = await import('$lib/server/porkbun');
		configurePorkbunForTests({ settings: ctx.settings, fetch: flaky as never, db: ctx.db });
		const res = await batch(changes);
		expect(res.status).toBe(207);
		expect(res.body.items.map((i) => i.status)).toEqual(['failed', 'not_applied']);
		expect(res.body.items[0]?.error).toMatchObject({ code: 'UNREACHABLE', retryable: true });
	});

	it('refuses the whole batch with a 409 when one change clashes, before any write', async () => {
		const www = await find('www', 'A');
		const res = await call(batchRoute, 'POST', `${BASE}/batch`, {
			changes: [
				{ op: 'create', record: { host: 'fine', type: 'A', content: '198.51.100.1' } },
				{
					op: 'edit',
					id: www.id,
					record: { host: 'www', type: 'A', content: '203.0.113.11' },
					expect: { ...snapshotOf(www), ttl: 900 }
				},
				{ op: 'delete', id: '424242' }
			]
		});
		expect(res.status).toBe(409);
		const body = res.body as { code: string; message: string; items: { problems: { code: string }[] }[] };
		expect(body.code).toBe('PLAN_REFUSED');
		expect(body.message).toMatch(/^Nothing was changed\. Change 2 can not be applied/);
		expect(body.items.map((i) => i.problems[0]?.code)).toEqual([undefined, 'STALE', 'MISSING']);
		expect(writesSoFar()).toBe(0);
		expect(await zone()).toHaveLength(11);
	});

	it('refuses the whole batch with a 400 when one record is invalid, before any write', async () => {
		const res = await call(batchRoute, 'POST', `${BASE}/batch`, {
			changes: [
				{ op: 'create', record: { host: 'fine', type: 'A', content: '198.51.100.1' } },
				{ op: 'create', record: { host: 'bad', type: 'MX', content: '203.0.113.1', prio: 10 } }
			]
		});
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ code: 'INVALID_RECORD', index: 1 });
		expect(writesSoFar()).toBe(0);
	});

	it('wants the domain name typed to delete more than one record', async () => {
		const [a, b] = await zone();
		const changes: RecordChange[] = [
			{ op: 'delete', id: (a as DnsRecord).id },
			{ op: 'delete', id: (b as DnsRecord).id }
		];
		for (const confirm of [undefined, 'example.org', 42]) {
			const res = await call(batchRoute, 'POST', `${BASE}/batch`, { changes, confirm });
			expect(res.status).toBe(400);
			expect(res.body).toMatchObject({ code: 'CONFIRM_REQUIRED' });
		}
		expect(writesSoFar()).toBe(0);
		const res = await batch(changes, { confirm: ' Example.COM ' });
		expect(res.status).toBe(200);
		expect(res.body.counts.applied).toBe(2);
		expect(await zone()).toHaveLength(9);
		// One delete needs no typing.
		const [c] = await zone();
		expect((await batch([{ op: 'delete', id: (c as DnsRecord).id }])).status).toBe(200);
	});

	it('adopts a duplicate inside a batch and carries on', async () => {
		const mx = await find('', 'MX');
		// The plan sees an empty zone, so only Porkbun notices that the MX record is there already.
		await porkbunStatus();
		ctx.fake.respondNext({ status: 200, body: { status: 'SUCCESS', records: [] } });
		const res = await batch([
			{ op: 'create', record: { host: '', type: 'MX', content: 'mail.example.com', prio: 10 } },
			{ op: 'create', record: { host: 'next', type: 'A', content: '198.51.100.1' } }
		]);
		expect(res.status).toBe(200);
		expect(res.body.items.map((i) => [i.status, i.id === mx.id])).toEqual([
			['adopted', true],
			['applied', false]
		]);
		expect(res.body.warnings[0]).toMatch(/already there/);
	});
});

describe('export and import', () => {
	const everything = () => [
		...DNS_RECORD_TYPES.map((type) => ({
			name: SAMPLES[type].host,
			type,
			content: SAMPLES[type].content,
			ttl: type === 'CAA' ? 3600 : 600,
			...(SAMPLES[type].prio !== undefined ? { prio: SAMPLES[type].prio as number } : {})
		})),
		{ name: '', type: 'A', content: '203.0.113.10', ttl: 600 },
		{ name: '*', type: 'A', content: '203.0.113.10', ttl: 900 },
		{ name: '', type: 'MX', content: 'mail.example.com', ttl: 600, prio: 10 },
		{ name: '', type: 'TXT', content: 'v=spf1 mx -all', ttl: 600 },
		{
			name: 'key1._domainkey',
			type: 'TXT',
			content: `v=DKIM1; k=rsa; p=${'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'.repeat(14)}`,
			ttl: 600
		},
		{ name: 'odd', type: 'TXT', content: 'say "hi" \\ back; semi (paren) and ünïcödé ✓', ttl: 86400 },
		{ name: 'www', type: 'A', content: '203.0.113.10', ttl: 600, notes: 'served by Caddy' }
	];

	const dataOf = (domain: string) =>
		ctx.fake
			.records(domain)
			.map((r) => `${r.host}|${r.type}|${r.content}|${r.ttl}|${r.prio ?? ''}`)
			.sort();

	it.each(['zone', 'json'])(
		'exports a zone as %s and imports it into an empty zone as the same records',
		async (format) => {
			ctx.fake.setRecords(D, everything());
			const before = dataOf(D);
			expect(before).toHaveLength(21);

			const exported = await call(exportRoute, 'GET', `${BASE}/export?format=${format}`);
			expect(exported.status).toBe(200);
			expect(exported.res.headers.get('content-disposition')).toBe(
				`attachment; filename="example.com.${format === 'json' ? 'json' : 'zone'}"`
			);
			expect(exported.res.headers.get('cache-control')).toBe('no-store');
			const text = await exported.res.text();

			ctx.fake.setRecords(D, []);
			const review = await importCall({ text, dryRun: true });
			expect(review.status).toBe(200);
			expect(review.body).toMatchObject({ dryRun: true, ok: true, source: format, unreadable: [] });
			expect(review.body.counts).toEqual({ new: 21, existing: 0, conflict: 0, ignored: 0, invalid: 0 });
			expect(review.body.porkbun).toMatchObject({ dryRun: true, created: 20, skipped: 0, failed: 0 });
			// The rehearsal changed nothing.
			expect(dataOf(D)).toEqual([]);
			expect(writesSoFar()).toBe(0);
			// The note is reported; an import does not carry it.
			expect(review.body.entries.find((e) => e.host === 'www')?.notes).toBe('served by Caddy');

			const done = await importCall({ text });
			expect(done.status).toBe(200);
			expect(done.body).toMatchObject({ dryRun: false, ok: true });
			expect(done.body.porkbun).toMatchObject({ created: 20, skipped: 0, failed: 0 });
			// The NS record of the delegated subdomain went out as a create of its own.
			expect(done.body.delegations).toMatchObject([
				{ status: 'applied', name: 'lab.example.com', type: 'NS' }
			]);
			expect(dataOf(D)).toEqual(before);

			// One import call and one create, both in the write log.
			expect(ctx.fake.writes.map((r) => r.path)).toEqual([`dns/import/${D}`, `dns/create/${D}`]);
			expect(auditLog().entries.map((e) => [e.action, e.ok])).toEqual([
				['dns.create', true],
				['dns.import', true]
			]);

			// Importing the same file again creates nothing: everything is there.
			const again = await importCall({ text });
			expect(again.body.counts).toMatchObject({ new: 0, existing: 21 });
			expect(again.body.porkbun).toBeNull();
			expect(ctx.fake.writes).toHaveLength(2);
		}
	);

	it('exports the last good copy and says so when Porkbun can not be reached', async () => {
		await zone();
		ctx.fake.throwNext(new TypeError('fetch failed'));
		const res = await call(exportRoute, 'GET', `${BASE}/export`);
		expect(res.status).toBe(200);
		expect(await res.res.text()).toMatch(/Porkbun could not be reached for this export/);
	});

	it('sorts a pasted zone file out against the live zone and imports only what is new', async () => {
		const text = [
			'$ORIGIN example.com.',
			'@ 3600 IN SOA ns1.example.net. hostmaster.example.com. 1 7200 3600 1209600 3600',
			'@ IN NS maceio.ns.porkbun.com.',
			'@ IN A 203.0.113.10 ; already there',
			'new IN A 198.51.100.1',
			'blog IN A 198.51.100.2 ; clashes with the CNAME',
			'bad IN AAAA not-an-address',
			'ptr IN PTR host.example.com.',
			'elsewhere.example.net. IN A 198.51.100.3',
			'sub IN NS ns1.example.net.'
		].join('\n');
		const review = await importCall({ text, dryRun: true });
		expect(review.body.counts).toEqual({ new: 2, existing: 1, conflict: 1, ignored: 3, invalid: 1 });
		expect(review.body.unreadable).toEqual([
			{ line: 9, message: 'elsewhere.example.net is not under example.com, so the record was left out' }
		]);
		expect(review.body.ok).toBe(true);
		expect(writesSoFar()).toBe(0);

		const done = await importCall({ text });
		expect(done.body.porkbun).toMatchObject({ created: 1 });
		expect(done.body.delegations.map((d) => d.status)).toEqual(['applied']);
		const after = await zone();
		expect(after).toHaveLength(13);
		expect(after.some((r) => r.host === 'new' && r.content === '198.51.100.1')).toBe(true);
		expect(after.some((r) => r.host === 'sub' && r.type === 'NS')).toBe(true);
		expect(after.some((r) => r.host === 'blog' && r.type === 'A')).toBe(false);
	});

	it('discovers records with a scan, which only looks, and imports the ones sent back', async () => {
		const net = (body: object) =>
			call(importRoute, 'POST', '/api/porkbun/domains/example.net/dns/import', body, {
				domain: 'example.net'
			}) as Promise<{ status: number; body: ImportReview }>;
		const found = await net({ scan: true, dryRun: true });
		expect(found.status).toBe(200);
		expect(found.body.source).toBe('scan');
		expect(found.body.entries.map((e) => [e.type, e.verdict])).toEqual([
			['A', 'existing'],
			['CNAME', 'existing'],
			['MX', 'new'],
			['NS', 'ignored']
		]);
		expect(ctx.fake.records('example.net')).toHaveLength(2);
		expect(writesSoFar()).toBe(0);

		expect((await net({ scan: true })).status).toBe(400);

		const records = found.body.entries.filter((e) => e.verdict === 'new');
		const done = await net({ records });
		expect(done.body).toMatchObject({ source: 'records', ok: true, porkbun: { created: 1 } });
		// The zone is not served by Porkbun: its warning is passed on as written.
		expect(done.body.warnings[0]).toMatch(/delegated to nameservers we do not operate/);
		expect(
			ctx.fake
				.records('example.net')
				.map((r) => r.type)
				.sort()
		).toEqual(['A', 'CNAME', 'MX']);
	});

	it('refuses more than 500 new records, an empty text and a body without a source', async () => {
		const many = Array.from({ length: 501 }, (_, i) => `h${i} IN A 198.51.100.1`).join('\n');
		const res = await importCall({ text: many, dryRun: true });
		expect(res.status).toBe(400);
		expect((res.body as never as { message: string }).message).toMatch(/at most 500 in one import/);
		expect((await importCall({ text: '   ' })).status).toBe(400);
		expect((await importCall({})).status).toBe(400);
		expect(writesSoFar()).toBe(0);
	});

	it('reports what Porkbun could not import, with a 207', async () => {
		// Porkbun's own check refuses one record this UI's check let through.
		const text = 'ok IN A 198.51.100.1\nweird IN A 198.51.100.2';
		await zone();
		await porkbunStatus();
		const zoneRead = { status: 200, body: { status: 'SUCCESS', records: [] } };
		ctx.fake.respondNext(zoneRead);
		ctx.fake.respondNext({
			status: 200,
			body: {
				status: 'SUCCESS',
				created: 1,
				skipped: 0,
				failed: 1,
				failures: [{ name: 'weird', type: 'A', reason: 'Refused by policy.' }]
			}
		});
		const res = await importCall({ text });
		expect(res.status).toBe(207);
		expect(res.body.ok).toBe(false);
		expect(res.body.porkbun).toMatchObject({ created: 1, failed: 1, failures: [{ name: 'weird' }] });
	});
});
