import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Porkbun } from './client';
import { PorkbunError } from './errors';

// fixtures/mock/*.json are the example responses Porkbun's own mock server (GET /mock/<path>, no key needed)
// gave for every endpoint the client calls, captured on 18 Nov 2026 at spec version 3.107. Each file is named
// after its path with '/' as '-'. These tests feed them to the client, so the parsing is checked against
// Porkbun's shapes and not only against the fake this repository wrote itself.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock');
const fixture = (name: string): string => readFileSync(join(dir, `${name}.json`), 'utf8');

/** A client whose every request is answered with one fixture. */
function serving(name: string, status = 200): Porkbun {
	return new Porkbun({
		apiKey: 'pk1_fake_key_for_tests',
		apiSecret: 'sk1_fake_secret_for_tests',
		baseUrl: 'https://porkbun.invalid/api/json/v3',
		fetch: async () =>
			new Response(fixture(name), { status, headers: { 'content-type': 'application/json' } })
	});
}

const WARNING = expect.stringContaining('does NOT affect what resolves');

describe('Porkbun mock responses', () => {
	it('has a fixture for every endpoint in the plan', () => {
		expect(readdirSync(dir).sort()).toEqual(
			[
				'account-apiSettings',
				'account-balance',
				'dns-create',
				'dns-create.error',
				'dns-createDnssecRecord',
				'dns-delete',
				'dns-deleteByNameType',
				'dns-deleteDnssecRecord',
				'dns-diff',
				'dns-edit',
				'dns-editByNameType',
				'dns-getDnssecRecords',
				'dns-history',
				'dns-import',
				'dns-preflight',
				'dns-restore',
				'dns-retrieve',
				'dns-retrieve-id',
				'dns-retrieveByNameType',
				'dns-scan',
				'domain-addUrlForward',
				'domain-createGlue',
				'domain-deleteGlue',
				'domain-deleteUrlForward',
				'domain-get',
				'domain-getGlue',
				'domain-getNs',
				'domain-getUrlForwarding',
				'domain-listAll',
				'domain-updateAutoRenew',
				'domain-updateGlue',
				'domain-updateNs',
				'ping',
				'ping.error',
				'pricing-get',
				'ssl-retrieve'
			]
				.map((n) => `${n}.json`)
				.sort()
		);
	});

	it('ping', async () => {
		expect(await serving('ping').ping()).toEqual({
			ip: '1.2.3.4',
			credentialsValid: true,
			account: 'string',
			scopes: ['read', 'dns']
		});
	});

	it('the error shape', async () => {
		for (const name of ['ping.error', 'dns-create.error']) {
			const err = await serving(name, 400)
				.ping()
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PorkbunError);
			expect(err).toMatchObject({
				code: 'INVALID_DOMAIN',
				message: 'Invalid domain.',
				httpStatus: 400,
				nextAction: { type: 'fix_request', url: 'https://porkbun.com/account/api', retryable: false },
				details: { account: 'string' }
			});
		}
	});

	it('domain/listAll and domain/get', async () => {
		expect(await serving('domain-listAll').domains.list()).toEqual([
			{
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
				labels: [{ id: 'string', title: 'string', color: 'string' }]
			}
		]);
		// The mock's dates here are the literal "string": not a date, so ''.
		expect(await serving('domain-get').domains.get('example.com')).toMatchObject({
			domain: 'example.com',
			createDate: '',
			expireDate: '',
			autoRenew: false,
			labels: []
		});
	});

	it('domain/updateAutoRenew', async () => {
		const res = await serving('domain-updateAutoRenew').domains.setAutoRenew(['example.com'], true);
		expect(res.results).toEqual([{ domain: 'example', ok: false, message: 'string' }]);
	});

	it('dns/retrieve in its three forms', async () => {
		const record = {
			id: 'string',
			name: 'www.example.com',
			host: 'www',
			type: 'A',
			content: '1.2.3.4',
			ttl: 600,
			prio: 10,
			notes: 'string'
		};
		expect(await serving('dns-retrieve').dns.list('example.com')).toEqual({
			records: [record],
			cloudflare: true
		});
		expect(await serving('dns-retrieve-id').dns.get('example.com', '1')).toEqual(record);
		expect(await serving('dns-retrieveByNameType').dns.listByNameType('example.com', 'A', 'www')).toEqual([
			record
		]);
	});

	it('dns writes', async () => {
		const created = await serving('dns-create').dns.create('example.com', {
			host: 'www',
			type: 'A',
			content: '1.2.3.4'
		});
		expect(created).toEqual({ id: '123456789', warnings: [WARNING], requestId: undefined });
		const pb = (name: string) => serving(name).dns;
		for (const res of [
			await pb('dns-edit').edit('example.com', '1', { content: '1.2.3.4' }),
			await pb('dns-editByNameType').editByNameType('example.com', 'A', 'www', { content: '1.2.3.4' }),
			await pb('dns-delete').delete('example.com', '1'),
			await pb('dns-deleteByNameType').deleteByNameType('example.com', 'A', 'www')
		]) {
			expect(res.warnings).toEqual([WARNING]);
		}
	});

	it('dns/history, dns/diff and dns/restore', async () => {
		expect(await serving('dns-history').dns.history('example.com')).toEqual([
			{
				id: 1234,
				takenAt: '2026-09-16T22:14:19Z',
				reason: 'before-edit',
				source: 'auto',
				recordCount: 9,
				matchesLive: false
			}
		]);
		const row = { name: 'www.example.com', type: 'A', content: '203.0.113.10', ttl: 600, prio: null };
		expect(await serving('dns-diff').dns.diff('example.com', 1234)).toEqual({
			snapshot: { id: 1234, takenAt: '2026-09-16T22:14:19Z', reason: 'before-edit' },
			missing: [row],
			extra: [row],
			inSync: false
		});
		expect(await serving('dns-restore').dns.restore('example.com', 1234)).toMatchObject({
			dryRun: false,
			restoredFrom: 1234,
			previousStateSavedAs: 1240,
			restored: 2,
			removed: 0,
			failed: [{ name: 'string', type: 'string', reason: 'string' }],
			warnings: [WARNING]
		});
	});

	it('dns/preflight', async () => {
		expect(await serving('dns-preflight').dns.preflight('example.com', 'move-nameservers')).toEqual({
			intent: 'move-nameservers',
			safe: false,
			blockers: ['string'],
			warnings: ['string'],
			checks: [
				{
					id: 'dnssec-active',
					severity: 'blocker',
					ok: true,
					title: 'string',
					detail: 'string',
					nextAction: 'string'
				}
			]
		});
	});

	it('dns/scan and dns/import', async () => {
		expect(await serving('dns-scan').dns.scan('example.com')).toEqual([
			{ host: 'www', type: 'A', content: '203.0.113.10', ttl: 600, prio: 10 }
		]);
		expect(await serving('dns-import').dns.import('example.com', 'scan')).toMatchObject({
			created: 0,
			skipped: 0,
			failed: 0,
			failures: [{}],
			warnings: [WARNING]
		});
	});

	it('dnssec', async () => {
		expect(await serving('dns-getDnssecRecords').dnssec.list('example.com')).toEqual([
			{ keyTag: 'string', alg: 'string', digestType: 'string', digest: 'string', pubKey: 'string' }
		]);
		const input = { keyTag: '1', alg: '13', digestType: '2', digest: 'AB' };
		expect((await serving('dns-createDnssecRecord').dnssec.create('example.com', input)).warnings).toEqual([
			'string'
		]);
		expect((await serving('dns-deleteDnssecRecord').dnssec.delete('example.com', '1')).warnings).toEqual([
			WARNING
		]);
	});

	it('nameservers and glue', async () => {
		expect(await serving('domain-getNs').ns.get('example.com')).toEqual([
			'ns1.porkbun.com',
			'ns2.porkbun.com'
		]);
		expect(
			(await serving('domain-updateNs').ns.update('example.com', ['a.example', 'b.example'])).warnings
		).toEqual([WARNING]);
		expect(await serving('domain-getGlue').glue.list('example.com')).toEqual([
			{ host: 'ns1.example.com', v4: ['192.0.2.1'], v6: ['2001:db8::1'] }
		]);
		const glue = (name: string) => serving(name).glue;
		await glue('domain-createGlue').create('example.com', 'ns1', ['192.0.2.1']);
		await glue('domain-updateGlue').update('example.com', 'ns1', ['192.0.2.1']);
		await glue('domain-deleteGlue').delete('example.com', 'ns1');
	});

	it('url forwarding', async () => {
		expect(await serving('domain-getUrlForwarding').forwards.list('example.com')).toEqual([
			{
				id: 'string',
				subdomain: 'string',
				location: 'string',
				redirectType: '301',
				includePath: true,
				wildcard: true
			}
		]);
		const input = {
			subdomain: '',
			location: 'https://example.org',
			redirectType: '302',
			includePath: false,
			wildcard: false
		} as const;
		await serving('domain-addUrlForward').forwards.add('example.com', input);
		await serving('domain-deleteUrlForward').forwards.delete('example.com', '1');
	});

	it('ssl, pricing and account', async () => {
		expect(await serving('ssl-retrieve').ssl.retrieve('example.com')).toEqual({
			certificateChain: 'string',
			privateKey: 'string',
			publicKey: 'string'
		});
		expect(await serving('pricing-get').pricing.get()).toEqual({
			example: { registration: '9.73', renewal: '9.73', transfer: '9.73', specialType: 'string' }
		});
		expect(await serving('account-balance').account.balance()).toEqual({ cents: 0, display: 'string' });
		expect(await serving('account-apiSettings').account.apiSettings()).toEqual({
			monthlySpendLimit: 0,
			lowBalanceAlert: 0,
			autoTopup: true,
			monthlySpend: 0,
			spendLimit: { limit: 0, source: 'account', spent: 0, remaining: 0 }
		});
	});
});
