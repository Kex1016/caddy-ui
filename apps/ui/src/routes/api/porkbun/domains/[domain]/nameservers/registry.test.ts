import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PORKBUN_NAMESERVERS, type Cached, type GlueHost, type WriteResult } from '$lib/api/porkbun';
import type { DnssecCheck, NameserverRehearsal, PreflightBlocked } from '$lib/porkbun/registry/types';
import { auditLog, porkbun } from '$lib/server/porkbun';
import { resetPorkbunForTests, useFakePorkbun, type FakeContext } from '$lib/server/porkbun/testing';
import { DELETE as dnssecDelete } from '../dnssec/[keytag]/+server';
import { GET as dnssecGet, POST as dnssecPost } from '../dnssec/+server';
import { DELETE as glueDelete, PUT as gluePut } from '../glue/[host]/+server';
import { GET as glueGet, POST as gluePost } from '../glue/+server';
import { GET as nsGet, PUT as nsPut } from './+server';

let ctx: FakeContext;
beforeEach(() => (ctx = useFakePorkbun()));
afterEach(() => resetPorkbunForTests());

function event(
	domain: string,
	opts: { params?: Record<string, string>; method?: string; body?: unknown } = {}
) {
	const url = new URL(`http://localhost/api/porkbun/domains/${domain}/x`);
	return {
		url,
		params: { domain, ...opts.params },
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

const ELSEWHERE = ['ns1.example-dns.net', 'ns2.example-dns.net'];
const DS = {
	keyTag: '12345',
	alg: '13',
	digestType: '2',
	digest: 'AB'.repeat(32)
};

describe('nameservers', () => {
	const put = (domain: string, body: unknown) => nsPut(event(domain, { method: 'PUT', body }));

	it('reads them, cached under <domain>:ns', async () => {
		const body = (await (await nsGet(event('example.com'))).json()) as Cached<string[]>;
		expect(body.data).toEqual([...PORKBUN_NAMESERVERS].sort());
		const n = ctx.fake.requests.length;
		await nsGet(event('example.com'));
		expect(ctx.fake.requests.length).toBe(n);
	});

	it('rehearses a change with the safety check and changes nothing', async () => {
		const res = await put('example.com', { ns: ELSEWHERE, dryRun: true });
		const body = (await res.json()) as NameserverRehearsal;
		expect(body.dryRun.wouldSucceed).toBe(true);
		expect(body.preflight.intent).toBe('move-nameservers');
		expect(ctx.fake.requests.some((r) => r.path.endsWith('preflight/example.com'))).toBe(true);
		expect(ctx.fake.writes).toHaveLength(0);
	});

	it('needs the domain typed, then changes them and logs the old set', async () => {
		const missing = await put('example.com', { ns: ELSEWHERE });
		expect((await missing.json()).code).toBe('CONFIRMATION_REQUIRED');
		expect(ctx.fake.writes).toHaveLength(0);

		const res = await put('example.com', { ns: ELSEWHERE, confirm: 'example.com' });
		expect(res.status).toBe(200);
		expect(((await res.json()) as WriteResult).ok).toBe(true);
		expect(await porkbun().ns.get('example.com')).toEqual(ELSEWHERE);
		const [entry] = auditLog({ domain: 'example.com' }).entries;
		expect(entry).toMatchObject({ action: 'ns.update', request: { ns: ELSEWHERE } });
		expect((entry!.before as { ns: string[] }).ns).toHaveLength(4);
	});

	it('is refused while the safety check reports a blocker (active DNSSEC)', async () => {
		const res = await put('example.net', { ns: [...PORKBUN_NAMESERVERS], confirm: 'example.net' });
		expect(res.status).toBe(409);
		const body = (await res.json()) as PreflightBlocked;
		expect(body.code).toBe('PREFLIGHT_BLOCKED');
		expect(body.preflight.blockers).toContain('dnssec-active');
		expect(body.message).toContain('DNSSEC is active');
		expect(ctx.fake.writes).toHaveLength(0);
		expect(await porkbun().ns.get('example.net')).toEqual(ELSEWHERE);
	});

	it('refuses bad lists before any call', async () => {
		for (const ns of [['only.one.example'], ['a.example', 'a.example'], ['not a host', 'b.example'], 'x']) {
			const res = await put('example.com', { ns, confirm: 'example.com' });
			expect(res.status).toBe(400);
		}
		expect(ctx.fake.requests.filter((r) => r.path.startsWith('domain/updateNs'))).toHaveLength(0);
	});

	it('refuses a change to the same set', async () => {
		const res = await put('example.com', {
			ns: [...PORKBUN_NAMESERVERS].reverse().map((n) => n.toUpperCase() + '.'),
			confirm: 'example.com'
		});
		expect(res.status).toBe(400);
		expect(ctx.fake.writes).toHaveLength(0);
	});

	it('is refused in read-only mode and without the domains permission', async () => {
		resetPorkbunForTests();
		ctx = useFakePorkbun({ settings: { readonly: true } });
		const ro = await thrown(() => put('example.com', { ns: ELSEWHERE, dryRun: true }));
		expect(isHttpError(ro) && ro.status).toBe(403);

		resetPorkbunForTests();
		ctx = useFakePorkbun();
		ctx.fake.scopes = ['read', 'dns'];
		await nsGet(event('example.com', { params: {} }));
		const { porkbunStatus } = await import('$lib/server/porkbun');
		await porkbunStatus({ force: true });
		const scoped = await thrown(() => put('example.com', { ns: ELSEWHERE, confirm: 'example.com' }));
		expect(isHttpError(scoped) && scoped.status).toBe(403);
	});
});

describe('glue', () => {
	it('lists, adds, edits and deletes a glue host', async () => {
		const list = async () =>
			((await (await glueGet(event('example.com'))).json()) as Cached<GlueHost[]>).data;
		expect(await list()).toEqual([{ host: 'ns1.example.com', v4: ['192.0.2.1'], v6: ['2001:db8::1'] }]);

		const add = await gluePost(
			event('example.com', {
				method: 'POST',
				body: { host: 'ns2.example.com', ips: '192.0.2.2, 2001:db8::2' }
			})
		);
		expect(((await add.json()) as WriteResult).ok).toBe(true);
		expect(await list()).toContainEqual({ host: 'ns2.example.com', v4: ['192.0.2.2'], v6: ['2001:db8::2'] });

		const edit = await gluePut(
			event('example.com', { method: 'PUT', params: { host: 'ns2' }, body: { ips: ['192.0.2.3'] } })
		);
		expect(((await edit.json()) as WriteResult).ok).toBe(true);
		expect(await list()).toContainEqual({ host: 'ns2.example.com', v4: ['192.0.2.3'], v6: [] });

		const noConfirm = await glueDelete(event('example.com', { method: 'DELETE', params: { host: 'ns2' } }));
		expect(noConfirm.status).toBe(400);
		const del = await glueDelete(
			event('example.com', { method: 'DELETE', params: { host: 'ns2' }, body: { confirm: 'example.com' } })
		);
		expect(((await del.json()) as WriteResult).ok).toBe(true);
		expect((await list()).map((g) => g.host)).toEqual(['ns1.example.com']);

		const actions = auditLog({ domain: 'example.com' }).entries.map((e) => e.action);
		expect(actions).toEqual(['glue.delete', 'glue.update', 'glue.create']);
		expect(auditLog({ domain: 'example.com' }).entries[0]!.before).toMatchObject({ host: 'ns2.example.com' });
	});

	it('refuses bad hosts and addresses before any call', async () => {
		const bodies = [
			{ host: 'ns1.other.test.', ips: ['192.0.2.1'] },
			{ host: 'example.com', ips: ['192.0.2.1'] },
			{ host: 'ns 3', ips: ['192.0.2.1'] },
			{ host: 'ns3', ips: [] },
			{ host: 'ns3', ips: ['300.1.1.1'] },
			{ host: 'ns3', ips: ['2001:db8:::1'] }
		];
		for (const body of bodies) {
			const res = await gluePost(event('example.com', { method: 'POST', body }));
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
		expect(ctx.fake.writes).toHaveLength(0);
	});

	it('says 404 for a host with no glue', async () => {
		const res = await gluePut(
			event('example.com', { method: 'PUT', params: { host: 'ns9' }, body: { ips: ['192.0.2.9'] } })
		);
		expect(res.status).toBe(404);
		expect(ctx.fake.writes).toHaveLength(0);
	});
});

describe('DNSSEC', () => {
	const post = (domain: string, body: unknown) => dnssecPost(event(domain, { method: 'POST', body }));

	it('lists the DS records', async () => {
		const body = await (await dnssecGet(event('example.net'))).json();
		expect(body.data).toEqual([expect.objectContaining({ keyTag: '2371', alg: '13', digestType: '2' })]);
	});

	it('checks first, then adds with the domain typed', async () => {
		const check = await post('example.com', { ...DS, check: true });
		const body = (await check.json()) as DnssecCheck;
		expect(body.preflight.intent).toBe('enable-dnssec');
		expect(ctx.fake.writes).toHaveLength(0);

		expect((await post('example.com', DS)).status).toBe(400);
		const res = await post('example.com', { ...DS, confirm: 'example.com' });
		expect(((await res.json()) as WriteResult).ok).toBe(true);
		expect(await porkbun().dnssec.list('example.com')).toEqual([DS]);
		expect(auditLog({ domain: 'example.com' }).entries[0]).toMatchObject({ action: 'dnssec.create' });
	});

	it('refuses an add while the enable-dnssec check reports a blocker', async () => {
		ctx.fake.setRecords('example.com', [
			{ name: 'www', type: 'CNAME', content: 'example.org', ttl: 600 },
			{ name: 'www', type: 'TXT', content: 'clash', ttl: 600 }
		]);
		const res = await post('example.com', { ...DS, confirm: 'example.com' });
		expect(res.status).toBe(409);
		expect(((await res.json()) as PreflightBlocked).preflight.blockers).toContain('cname-exclusivity');
		expect(ctx.fake.writes).toHaveLength(0);
	});

	it('refuses malformed and retired records before any call', async () => {
		const bad = [
			{ ...DS, keyTag: '70000' },
			{ ...DS, alg: '5' },
			{ ...DS, digest: 'XYZ' },
			{ ...DS, digest: 'AB'.repeat(20) },
			{ ...DS, keyDataFlags: '257' }
		];
		for (const body of bad) {
			const res = await post('example.com', { ...body, confirm: 'example.com' });
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
		expect(ctx.fake.requests.filter((r) => r.path.includes('Dnssec'))).toHaveLength(0);
	});

	it('refuses a key tag that exists, and passes Porkbun warnings on', async () => {
		const dup = await post('example.net', { ...DS, keyTag: '2371', confirm: 'example.net' });
		expect(dup.status).toBe(409);
		const sha1 = await post('example.com', {
			...DS,
			digestType: '1',
			digest: 'AB'.repeat(20),
			confirm: 'example.com'
		});
		const body = (await sha1.json()) as WriteResult;
		expect(body.ok && body.warnings[0]).toContain('SHA-1');
	});

	it('deletes with the domain typed, and logs the deleted record', async () => {
		const del = (body?: unknown) =>
			dnssecDelete(event('example.net', { method: 'DELETE', params: { keytag: '2371' }, body }));
		expect((await del()).status).toBe(400);
		expect((await del({ confirm: 'example.com' })).status).toBe(400);
		expect(ctx.fake.writes).toHaveLength(0);
		const res = await del({ confirm: 'example.net' });
		expect(((await res.json()) as WriteResult).ok).toBe(true);
		expect(await porkbun().dnssec.list('example.net')).toEqual([]);
		const [entry] = auditLog({ domain: 'example.net' }).entries;
		expect(entry).toMatchObject({ action: 'dnssec.delete', request: { keyTag: '2371' } });
		expect((entry!.before as { records: unknown[] }).records).toHaveLength(1);

		const gone = await del({ confirm: 'example.net' });
		expect(gone.status).toBe(404);
	});

	it('after DNSSEC is removed, the nameserver move is allowed', async () => {
		await dnssecDelete(
			event('example.net', { method: 'DELETE', params: { keytag: '2371' }, body: { confirm: 'example.net' } })
		);
		const res = await nsPut(
			event('example.net', { method: 'PUT', body: { ns: [...PORKBUN_NAMESERVERS], confirm: 'example.net' } })
		);
		expect(res.status).toBe(200);
	});
});
