import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainSummary, PorkbunStatus } from '$lib/api/porkbun';
import { setConfigServiceForTests } from '$lib/server/config';
import { FakeAdmin } from '$lib/server/config/fake-admin';
import { ConfigService } from '$lib/server/config/service';
import { readZone } from '$lib/porkbun/records/service.server';
import { PluginDetector, setPluginDetectorForTests } from '$lib/server/caddy/porkbun/plugin';
import { PluginAdmin } from '$lib/server/caddy/porkbun/testing';
import { openDb } from '$lib/server/db';
import { porkbunStatus, requireDomain } from '$lib/server/porkbun';
import { resetPorkbunForTests, useFakePorkbun } from '$lib/server/porkbun/testing';
import { GET as tieInRoute } from '../../../api/porkbun/caddy/+server';
import { load, type DnsPageData } from './+page.server';
import Page from './+page.svelte';

const CADDYFILE = [
	'www.example.com {',
	'\trespond hello',
	'}',
	'',
	'https://blog.example.com:8443, shop.example.com {',
	'\treverse_proxy 127.0.0.1:8080',
	'}',
	'',
	'elsewhere.test {',
	'\trespond no',
	'}',
	''
].join('\n');

let dir: string;
let svc: ConfigService;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'caddy-ui-p2-'));
	const file = join(dir, 'Caddyfile');
	await writeFile(file, CADDYFILE);
	svc = new ConfigService({
		admin: new FakeAdmin(),
		db: openDb(':memory:'),
		caddyfilePath: file,
		backupDir: join(dir, 'backups')
	});
	setConfigServiceForTests(svc);
});

afterEach(async () => {
	vi.useRealTimers();
	resetPorkbunForTests();
	setPluginDetectorForTests(undefined);
	svc.unwatch();
	setConfigServiceForTests(undefined);
	await rm(dir, { recursive: true, force: true });
});

const noTieIn = async () => new Response('Not found', { status: 404 });
const page = (domain: string, fetcher: unknown = noTieIn) =>
	load({ params: { domain }, fetch: fetcher } as never) as Promise<DnsPageData>;

const hostsOf = (data: DnsPageData, host: string, type: string) => {
	const record = data.zone?.data.records.find((r) => r.host === host && r.type === type);
	return record ? (data.marks[record.id]?.sites.map((s) => s.host) ?? []) : null;
};

describe('the DNS tab load', () => {
	it('makes no call with the keys unset', async () => {
		const { fake } = useFakePorkbun({ settings: { apiKey: undefined, apiSecret: undefined } });
		expect(await page('example.com')).toEqual({
			zone: null,
			zoneError: null,
			nameservers: null,
			sites: [],
			marks: {}
		});
		expect(fake.requests).toHaveLength(0);
	});

	it('leaves a domain outside the account to the layout', async () => {
		useFakePorkbun();
		expect(await page('not-mine.test')).toMatchObject({ zone: null, zoneError: null });
	});

	it('reads the zone and the nameservers, cached', async () => {
		const { fake } = useFakePorkbun();
		const data = await page('example.com');
		expect(data.zone?.data.records).toHaveLength(11);
		expect(data.zone?.stale).toBe(false);
		expect(data.zoneError).toBeNull();
		expect(data.nameservers?.every((n) => n.endsWith('.ns.porkbun.com'))).toBe(true);
		const n = fake.requests.length;
		await page('example.com');
		expect(fake.requests.length).toBe(n);
		expect(fake.writes).toHaveLength(0);
	});

	it('marks what Caddy depends on, from the Caddyfile alone', async () => {
		useFakePorkbun();
		const data = await page('example.com');
		expect(data.sites).toEqual([
			{ host: 'www.example.com', href: expect.stringMatching(/^\/sites\/.+/), disabled: false },
			{ host: 'blog.example.com', href: expect.stringMatching(/^\/sites\/.+/), disabled: false },
			{ host: 'shop.example.com', href: expect.stringMatching(/^\/sites\/.+/), disabled: false }
		]);
		expect(hostsOf(data, 'www', 'A')).toEqual(['www.example.com']);
		expect(hostsOf(data, 'blog', 'CNAME')).toEqual(['blog.example.com']);
		// shop has no record of its own: the wildcard answers for it.
		expect(hostsOf(data, '*', 'A')).toEqual(['shop.example.com']);
		expect(hostsOf(data, '', 'A')).toEqual([]);
		const challenge = data.zone?.data.records.find((r) => r.host === '_acme-challenge');
		expect(data.marks[challenge?.id ?? '']).toEqual({ managedByCaddy: true, sites: [] });
	});

	it('takes the pairs of sites and records from the Caddy tie-in when it answers', async () => {
		const { fake } = useFakePorkbun();
		const apex = fake.records('example.com').find((r) => r.host === '' && r.type === 'A');
		const asked: string[] = [];
		const data = await page('example.com', async (url: string) => {
			asked.push(url);
			return Response.json({
				plugin: true,
				sites: [{ host: 'blog.example.com', records: [{ id: apex?.id }] }]
			});
		});
		expect(asked).toEqual(['/api/porkbun/caddy?domain=example.com']);
		expect(hostsOf(data, '', 'A')).toEqual(['blog.example.com']);
		expect(hostsOf(data, 'www', 'A')).toEqual([]);
		// The link to the site still comes from the Caddyfile.
		const record = data.zone?.data.records.find((r) => r.host === '' && r.type === 'A');
		expect(data.marks[record?.id ?? '']?.sites[0]?.href).toMatch(/^\/sites\//);
	});

	it('reads the answer the tie-in gives today', async () => {
		useFakePorkbun();
		setPluginDetectorForTests(new PluginDetector(new PluginAdmin()));
		const answers: { status: number; sites: string[] }[] = [];
		const viaRoute = async (path: string) => {
			const res = await tieInRoute({ url: new URL(path, 'http://ui.test') } as never);
			const body = (await res.clone().json()) as { sites?: { host: string }[] };
			answers.push({ status: res.status, sites: (body.sites ?? []).map((s) => s.host) });
			return res;
		};
		const [own, data] = [await page('example.com'), await page('example.com', viaRoute)];
		// The tie-in did answer, with the three sites of this domain and not the one elsewhere.
		expect(answers).toEqual([
			{ status: 200, sites: ['www.example.com', 'blog.example.com', 'shop.example.com'] }
		]);
		// Both ways of working it out agree on this zone, record by record.
		const hosts = (d: DnsPageData) =>
			Object.fromEntries(Object.entries(d.marks).map(([id, m]) => [id, m.sites.map((s) => s.host).sort()]));
		expect(hosts(data)).toEqual(hosts(own));
		expect(hostsOf(data, 'www', 'A')).toEqual(['www.example.com']);
		expect(hostsOf(data, '*', 'A')).toEqual(['shop.example.com']);
		expect(data.marks).toEqual(own.marks);
	});

	it.each([
		['fails', async () => Promise.reject(new Error('boom'))],
		['answers something else', async () => Response.json({ sites: 'soon' })],
		['answers with text', async () => new Response('<html>')]
	])('works the marks out itself when the tie-in %s', async (_name, fetcher) => {
		useFakePorkbun();
		const data = await page('example.com', fetcher);
		expect(hostsOf(data, 'www', 'A')).toEqual(['www.example.com']);
	});

	it('does not wait for a tie-in that does not answer', async () => {
		useFakePorkbun();
		vi.useFakeTimers();
		const pending = page('example.com', () => new Promise(() => {}));
		await vi.advanceTimersByTimeAsync(2000);
		expect(hostsOf(await pending, 'www', 'A')).toEqual(['www.example.com']);
	});

	it('says why a zone can not be read', async () => {
		useFakePorkbun();
		const data = await page('example.org');
		expect(data.zone).toBeNull();
		expect(data.zoneError?.code).toBe('API_ACCESS_DISABLED');
	});

	it('still shows the zone when the Caddyfile can not be read', async () => {
		useFakePorkbun();
		setConfigServiceForTests({
			readFile: async () => {
				throw new Error('EACCES');
			}
		} as never);
		const data = await page('example.com');
		expect(data.zone?.data.records).toHaveLength(11);
		expect(data.sites).toEqual([]);
	});
});

describe('the DNS tab', () => {
	async function html(domain: string, change: (data: Record<string, unknown>) => void = () => {}) {
		const porkbun: PorkbunStatus = await porkbunStatus();
		const summary: DomainSummary = await requireDomain(domain);
		const data = {
			...(await page(domain)),
			porkbun,
			domain: summary,
			domainError: null,
			timeZone: 'Europe/Budapest'
		};
		change(data);
		return render(Page, { props: { data: data as never } }).body;
	}

	it('lists every record under its name, with what depends on it', async () => {
		useFakePorkbun();
		const out = await html('example.com');
		expect(out).toContain('<h2');
		expect(out).not.toContain('<h1');
		for (const text of [
			'DNS records',
			'www.example.com',
			'_sip._tcp.example.com',
			'203.0.113.10',
			'mail.example.com',
			'managed by Caddy',
			'used by www.example.com',
			'used by shop.example.com',
			'Add record',
			'Export',
			'11 records'
		]) {
			expect(out).toContain(text);
		}
		expect(out).not.toContain('The world does not see these records');
		expect(out).not.toContain('Records can be read, not changed');
		expect(out).not.toContain('pending change');
		expect(out).toContain('/api/porkbun/domains/example.com/dns/export');
	});

	it('shows a type it does not know without a way to change it', async () => {
		const { fake } = useFakePorkbun();
		fake.setRecords('example.com', [
			{ name: 'odd', type: 'LOC', content: '52 22 23.000 N 4 53 32.000 E -2.00m' },
			{ name: 'www', type: 'A', content: '203.0.113.10' }
		]);
		const out = await html('example.com');
		expect(out).toContain('read-only type');
		expect(out).toContain('aria-label="Edit A www.example.com"');
		expect(out).not.toContain('aria-label="Edit LOC odd.example.com"');
		expect(out).not.toContain('aria-label="Delete LOC odd.example.com"');
		expect(out).not.toContain('aria-label="Select LOC odd.example.com"');
	});

	it('keeps every control in read-only mode, disabled, and says why', async () => {
		useFakePorkbun({ settings: { readonly: true } });
		const out = await html('example.com');
		expect(out).toContain('Records can be read, not changed');
		expect(out).toContain('CADDY_UI_PORKBUN_READONLY');
		expect(out).toMatch(/<button[^>]*disabled[^>]*>(?:<!--[^>]*-->|\s|<svg[\s\S]*?<\/svg>)*Add record/);
		expect(out).toMatch(/<button[^>]*aria-label="Delete A www\.example\.com"[^>]*disabled/);
		// Reading and exporting stay.
		expect(out).toContain('203.0.113.10');
		expect(out).toContain('dns/export');
	});

	it('does the same when the key lacks the dns permission', async () => {
		const { fake } = useFakePorkbun();
		fake.scopes = ['read', 'domains'];
		const out = await html('example.com');
		expect(out).toContain('does not have the "dns" permission');
		expect(out).toMatch(/<button[^>]*aria-label="Edit A www\.example\.com"[^>]*disabled/);
	});

	it('says so when the domain is answered from somewhere else', async () => {
		useFakePorkbun();
		const out = await html('example.net');
		expect(out).toContain('The world does not see these records');
		expect(out).toContain('/domains/example.net/registry');
	});

	it('offers a first record for an empty zone', async () => {
		const { fake } = useFakePorkbun();
		fake.setRecords('example.com', []);
		const out = await html('example.com');
		expect(out).toContain('No records yet');
		expect(out).toContain('Add record');
	});

	it('shows why the zone can not be read, and no table', async () => {
		useFakePorkbun();
		const out = await html('example.com', (data) => {
			data.zone = null;
			data.zoneError = { code: 'UNREACHABLE', message: 'Porkbun did not answer.', retryable: true };
		});
		expect(out).toContain('Porkbun did not answer.');
		expect(out).not.toContain('<table');
		expect(out).not.toContain('Add record');
	});

	it('shows what Porkbun says along with the zone, as written', async () => {
		const { fake } = useFakePorkbun();
		expect(await html('example.com')).not.toContain('fp-notice--warning');
		const said =
			'example.com is served through Cloudflare & friends, so the records here are not what resolves.';
		fake.respondNext({
			status: 200,
			body: { status: 'SUCCESS', cloudflare: 'enabled', records: [], warnings: [said] }
		});
		await readZone('example.com', { force: true });
		const out = await html('example.com');
		expect(out).toContain(said.replace('&', '&amp;'));
		expect(out).toContain('No records yet');
	});

	it('says that the last good copy is shown when Porkbun can not be reached', async () => {
		useFakePorkbun();
		const out = await html('example.com', (data) => {
			data.zone = { ...(data.zone as object), stale: true };
		});
		expect(out).toContain('last good data as of');
		expect(out).toContain('Changes can not be applied');
	});
});
