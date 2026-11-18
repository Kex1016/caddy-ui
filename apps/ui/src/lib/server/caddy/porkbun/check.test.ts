import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaddyTieIn, SiteDnsCheck } from '$lib/api/porkbun-caddy';
import { resetPorkbunForTests, useFakePorkbun, type FakeContext } from '../../porkbun/testing';
import { caddyTieIn } from './check';
import { STALE_AFTER_MS } from './challenges';
import { useTieIn, type TieInContext } from './testing';

/** Every case of the cross-check (docs/porkbun-plan.md §5.1): apex, subdomain, wildcard, CNAME, not at Porkbun. */
const CADDYFILE = `{
	email admin@example.com
}

example.com {
	respond "apex"
}

www.example.com, mail.example.com {
	reverse_proxy 10.0.0.5:8080
}

app.example.com {
	reverse_proxy 10.0.0.6:8080
}

*.example.com {
	respond "wildcard"
}

shop.example.com, ext.example.com, nas.example.com, blog.example.com {
	respond "more"
}

site.example.net {
	tls {
		dns porkbun {
			api_key {env.PORKBUN_API_KEY}
			api_secret_key {env.PORKBUN_API_SECRET_KEY}
		}
	}
	respond "net"
}

example.org, *.example.org {
	tls {
		dns porkbun {
			api_key {env.PORKBUN_API_KEY}
			api_secret_key {env.PORKBUN_API_SECRET_KEY}
		}
	}
	respond "org"
}

app.example.dev, *.example.dev {
	respond "dev"
}

internal.example.com {
	tls internal
	respond "internal"
}

:8080, localhost, 10.0.0.9 {
	respond "not names"
}
`;

let pb: FakeContext;
let tie: TieInContext;

async function arrange(caddyfile = CADDYFILE, opts: { plugin?: boolean } = {}): Promise<void> {
	pb = useFakePorkbun();
	tie = await useTieIn(caddyfile, opts);
	const seed = pb.fake.records('example.com').map((r) => ({
		name: r.host,
		type: r.type,
		content: r.content,
		ttl: r.ttl
	}));
	pb.fake.setRecords('example.com', [
		...seed,
		{ name: 'shop', type: 'CNAME', content: 'www.example.com' },
		{ name: 'ext', type: 'CNAME', content: 'target.example.dev' },
		{ name: 'nas', type: 'A', content: '192.168.1.20' }
	]);
}

afterEach(async () => {
	await tie?.cleanup();
	resetPorkbunForTests();
});

const site = (t: CaddyTieIn, host: string): SiteDnsCheck => {
	const found = t.sites.find((s) => s.host === host);
	if (!found) throw new Error(`no check for ${host}; have ${t.sites.map((s) => s.host).join(', ')}`);
	return found;
};

describe('the site-to-DNS cross-check', () => {
	beforeEach(() => arrange());

	it('lists every site address that is a host name, and nothing else', async () => {
		const t = await caddyTieIn();
		expect(t.porkbun).toBe('ok');
		expect(t.publicIp).toBe('203.0.113.10');
		expect(t.caddyfileError).toBeNull();
		expect(t.sites.map((s) => s.host)).toEqual([
			'example.com',
			'www.example.com',
			'mail.example.com',
			'app.example.com',
			'*.example.com',
			'shop.example.com',
			'ext.example.com',
			'nas.example.com',
			'blog.example.com',
			'site.example.net',
			'example.org',
			'*.example.org',
			'app.example.dev',
			'*.example.dev',
			'internal.example.com'
		]);
		expect(t.domains.map((d) => d.domain)).toEqual(['example.com', 'example.net', 'example.org']);
	});

	it('apex: the A record points here', async () => {
		const s = site(await caddyTieIn(), 'example.com');
		expect(s).toMatchObject({ status: 'ok', domain: 'example.com', wildcard: false, fix: null, hints: [] });
		expect(s.records.map((r) => [r.type, r.name, r.content])).toContainEqual([
			'A',
			'example.com',
			'203.0.113.10'
		]);
		expect(s.line).toBe(5);
		expect(s.addresses).toEqual(['example.com']);
	});

	it('subdomain: its own record wins over the wildcard, right or wrong', async () => {
		const t = await caddyTieIn();
		expect(site(t, 'www.example.com')).toMatchObject({ status: 'ok', fix: null });
		const mail = site(t, 'mail.example.com');
		expect(mail.status).toBe('wrong');
		expect(mail.detail).toContain('203.0.113.25');
		expect(mail.fix).toMatchObject({
			kind: 'edit',
			domain: 'example.com',
			host: 'mail',
			type: 'A',
			content: '203.0.113.10',
			before: '203.0.113.25'
		});
		expect(mail.fix?.id).toBe(mail.records[0]?.id);
		// Both addresses share one site block.
		expect(mail.siteId).toBe(site(t, 'www.example.com').siteId);
	});

	it('wildcard: a name without a record of its own is answered by the wildcard record', async () => {
		const t = await caddyTieIn();
		const app = site(t, 'app.example.com');
		expect(app.status).toBe('ok');
		expect(app.detail).toContain('wildcard record *.example.com');
		expect(app.records.map((r) => r.name)).toEqual(['*.example.com']);
		const star = site(t, '*.example.com');
		expect(star).toMatchObject({ status: 'ok', wildcard: true });
		expect(star.records.map((r) => r.name)).toEqual(['*.example.com']);
	});

	it('wildcard pointing elsewhere: the name gets a record of its own instead of changing the wildcard', async () => {
		const records = pb.fake.records('example.com').map((r) => ({
			name: r.host,
			type: r.type,
			content: r.host === '*' ? '198.51.100.99' : r.content
		}));
		pb.fake.setRecords('example.com', records);
		const t = await caddyTieIn();
		expect(site(t, 'app.example.com').fix).toEqual({
			kind: 'create',
			domain: 'example.com',
			host: 'app',
			type: 'A',
			content: '203.0.113.10'
		});
		// The wildcard site itself is that record.
		expect(site(t, '*.example.com').fix).toMatchObject({ kind: 'edit', host: '*', before: '198.51.100.99' });
	});

	it('no record at all: offers to create one', async () => {
		pb.fake.setRecords('example.com', [{ name: '', type: 'A', content: '203.0.113.10' }]);
		const t = await caddyTieIn();
		const app = site(t, 'app.example.com');
		expect(app).toMatchObject({ status: 'missing', records: [] });
		expect(app.fix).toEqual({
			kind: 'create',
			domain: 'example.com',
			host: 'app',
			type: 'A',
			content: '203.0.113.10'
		});
		expect(site(t, '*.example.com').fix).toMatchObject({ kind: 'create', host: '*' });
	});

	it('CNAME inside the account is followed to its address', async () => {
		const shop = site(await caddyTieIn(), 'shop.example.com');
		expect(shop.status).toBe('ok');
		expect(shop.records.map((r) => [r.type, r.name])).toEqual([
			['CNAME', 'shop.example.com'],
			['A', 'www.example.com']
		]);
		expect(shop.detail).toContain('through CNAME www.example.com');
	});

	it('CNAME to a name outside the account can not be checked, and is not offered a fix', async () => {
		const ext = site(await caddyTieIn(), 'ext.example.com');
		expect(ext).toMatchObject({ status: 'external', fix: null });
		expect(ext.detail).toContain('target.example.dev');
	});

	it('CNAME into a zone that can not be read says so', async () => {
		const blog = site(await caddyTieIn(), 'blog.example.com');
		expect(blog).toMatchObject({ status: 'unreadable', fix: null });
		expect(blog.detail).toContain('example.org');
	});

	it('a private address is its own status, without a fix', async () => {
		const nas = site(await caddyTieIn(), 'nas.example.com');
		expect(nas).toMatchObject({ status: 'private', fix: null });
		expect(nas.detail).toContain('192.168.1.20');
	});

	it('not at Porkbun: names under no domain of the account', async () => {
		const t = await caddyTieIn();
		expect(site(t, 'app.example.dev')).toMatchObject({
			status: 'not_porkbun',
			domain: null,
			records: [],
			fix: null,
			hints: []
		});
	});

	it('nameservers elsewhere: the records at Porkbun are not what is served', async () => {
		const t = await caddyTieIn();
		const s = site(t, 'site.example.net');
		expect(s).toMatchObject({ status: 'elsewhere', fix: null, dns01: true });
		expect(s.detail).toContain('ns1.example-dns.net');
		expect(s.hints.map((h) => h.code)).toEqual(['dns01_nameservers_elsewhere']);
		expect(t.domains.find((d) => d.domain === 'example.net')).toMatchObject({
			servedByPorkbun: false,
			apiAccess: true
		});
	});

	it('API access off: unreadable, and the DNS challenge can not work', async () => {
		const t = await caddyTieIn();
		const s = site(t, 'example.org');
		expect(s).toMatchObject({ status: 'unreadable', fix: null });
		expect(s.hints.map((h) => h.code)).toEqual(['dns01_api_access_off']);
		expect(t.domains.find((d) => d.domain === 'example.org')).toMatchObject({
			apiAccess: false,
			error: { code: 'API_ACCESS_DISABLED' }
		});
		// The zone of a domain with API access off is never asked for.
		expect(pb.fake.requests.filter((r) => r.path.includes('example.org'))).toHaveLength(0);
	});

	it('wildcard hints: a wildcard site without the DNS challenge is told, and offered the Porkbun block', async () => {
		const t = await caddyTieIn();
		const star = site(t, '*.example.com');
		expect(star.dns01).toBe(false);
		expect(star.hints).toHaveLength(1);
		expect(star.hints[0]).toMatchObject({
			code: 'wildcard_needs_dns01',
			severity: 'warning',
			canAddPorkbun: true
		});
		// With the challenge set, no hint.
		expect(site(t, '*.example.org').hints.map((h) => h.code)).toEqual(['dns01_api_access_off']);
		// Not under a domain of the account: told, but the Porkbun block is not offered.
		const dev = site(t, '*.example.dev');
		expect(dev.hints[0]).toMatchObject({ code: 'wildcard_needs_dns01', canAddPorkbun: false });
		// `tls internal` never asks a public CA.
		expect(site(t, 'internal.example.com').hints).toEqual([]);
	});

	it('uses one zone read per domain and the shared cache', async () => {
		await caddyTieIn();
		const lists = () => pb.fake.requests.filter((r) => r.path.startsWith('dns/retrieve/')).length;
		expect(lists()).toBe(2);
		await caddyTieIn();
		expect(lists()).toBe(2);
		await caddyTieIn({ force: true });
		expect(lists()).toBe(4);
	});

	it('narrows to one domain or one address', async () => {
		const one = await caddyTieIn({ domain: 'example.net' });
		expect(one.sites.map((s) => s.host)).toEqual(['site.example.net']);
		expect(one.domains.map((d) => d.domain)).toEqual(['example.net']);
		const host = await caddyTieIn({ host: 'mail.example.com' });
		expect(host.sites.map((s) => s.host)).toEqual(['mail.example.com']);
	});
});

describe('the cross-check when something is not there', () => {
	it('says the plugin is missing on sites that use the Porkbun challenge, and does not offer the block', async () => {
		await arrange(CADDYFILE, { plugin: false });
		const t = await caddyTieIn();
		expect(t.plugin.state).toBe('missing');
		expect(site(t, 'site.example.net').hints.map((h) => h.code)).toEqual([
			'dns01_plugin_missing',
			'dns01_nameservers_elsewhere'
		]);
		const star = site(t, '*.example.com').hints[0];
		expect(star).toMatchObject({ code: 'wildcard_needs_dns01', canAddPorkbun: false });
		expect(star?.message).toContain('no Porkbun plugin');
	});

	it('a global acme_dns covers every site', async () => {
		await arrange(`{
	acme_dns porkbun {
		api_key {env.PORKBUN_API_KEY}
		api_secret_key {env.PORKBUN_API_SECRET_KEY}
	}
}

*.example.com {
	respond "wildcard"
}

app.example.dev {
	respond "dev"
}
`);
		const t = await caddyTieIn();
		expect(t.globalDns01).toEqual({ provider: 'porkbun' });
		expect(site(t, '*.example.com')).toMatchObject({
			dns01: true,
			dns01Detail: { source: 'global', provider: 'porkbun' },
			hints: []
		});
		expect(site(t, 'app.example.dev').hints.map((h) => h.code)).toEqual(['dns01_not_in_account']);
	});

	it('answers with the plugin check and no sites when the UI has no Porkbun keys', async () => {
		pb = useFakePorkbun({ settings: { apiKey: undefined, apiSecret: undefined } });
		tie = await useTieIn(CADDYFILE);
		const t = await caddyTieIn();
		expect(t).toMatchObject({ porkbun: 'off', sites: [], domains: [], challenges: [] });
		expect(t.plugin.state).toBe('present');
		expect(pb.fake.requests).toHaveLength(0);
	});

	it('reports why when Porkbun refuses the keys', async () => {
		pb = useFakePorkbun({ settings: { apiKey: 'pk1_wrong' } });
		tie = await useTieIn(CADDYFILE);
		const t = await caddyTieIn();
		expect(t.sites).toEqual([]);
		expect(t.porkbun).toBe('error');
		expect(JSON.stringify(t)).not.toContain('pk1_wrong');
	});

	it('compares nothing when the public IP is not known', async () => {
		await arrange();
		pb.fake.setRecords('example.com', [{ name: '', type: 'AAAA', content: '2001:db8::10' }]);
		const t = await caddyTieIn();
		// Only the other address family has a record.
		expect(site(t, 'example.com')).toMatchObject({ status: 'unverified', fix: null });
	});

	it('says so when there is no Caddyfile', async () => {
		await arrange();
		await rm(tie.file);
		const t = await caddyTieIn();
		expect(t.caddyfileError).toContain('does not exist');
		expect(t.plugin.state).toBe('present');
		expect(t.sites).toEqual([]);
	});
});

describe('challenge records', () => {
	beforeEach(() => arrange());

	it('are listed with the site they belong to, and go stale a day after they were first seen', async () => {
		const start = 1_800_000_000_000;
		const first = await caddyTieIn({ now: start });
		expect(first.challenges).toHaveLength(1);
		expect(first.challenges[0]).toMatchObject({
			domain: 'example.com',
			name: '_acme-challenge.example.com',
			subject: 'example.com',
			firstSeen: start,
			stale: false,
			sites: ['example.com', '*.example.com']
		});

		const later = await caddyTieIn({ now: start + STALE_AFTER_MS + 1 });
		expect(later.challenges[0]).toMatchObject({ firstSeen: start, stale: true });
	});

	it('forget a record that is gone, so a new one starts fresh', async () => {
		const start = 1_800_000_000_000;
		await caddyTieIn({ now: start });
		const rest = pb.fake
			.records('example.com')
			.filter((r) => r.host !== '_acme-challenge')
			.map((r) => ({ name: r.host, type: r.type, content: r.content }));
		pb.fake.setRecords('example.com', rest);
		expect((await caddyTieIn({ now: start + 1000, force: true })).challenges).toEqual([]);
		pb.fake.setRecords('example.com', [
			...rest,
			{ name: '_acme-challenge.app', type: 'TXT', content: 'another-fake-token' }
		]);
		const again = await caddyTieIn({ now: start + 2 * STALE_AFTER_MS, force: true });
		expect(again.challenges).toHaveLength(1);
		expect(again.challenges[0]).toMatchObject({
			subject: 'app.example.com',
			firstSeen: start + 2 * STALE_AFTER_MS,
			stale: false,
			sites: ['app.example.com']
		});
	});
});
