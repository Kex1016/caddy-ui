import { describe, expect, it } from 'vitest';
import type { DnsRecord } from '$lib/api/porkbun';
import {
	dependents,
	isAcmeChallenge,
	markRecords,
	marksFromCaddy,
	recordsBehind,
	siteHostOf,
	sitesInDomain,
	type SiteUse
} from './marks';

const D = 'example.com';

let nextId = 1;
const rec = (host: string, type: string, content: string): DnsRecord => ({
	id: String(nextId++),
	name: host === '' ? D : `${host}.${D}`,
	host,
	type,
	content,
	ttl: 600,
	prio: null,
	notes: null
});

const zone = () => {
	nextId = 1;
	return [
		rec('', 'A', '203.0.113.10'), // 1
		rec('', 'MX', 'mail.example.com'), // 2
		rec('www', 'CNAME', 'example.com'), // 3
		rec('*', 'A', '203.0.113.20'), // 4
		rec('blog', 'CNAME', 'pages.example.net'), // 5
		rec('mail', 'TXT', 'v=spf1 -all'), // 6
		rec('_acme-challenge', 'TXT', 'token'), // 7
		rec('_acme-challenge.www', 'TXT', 'token'), // 8
		rec('a.deep', 'A', '203.0.113.30'), // 9
		rec('*.deep', 'AAAA', '2001:db8::1'), // 10
		rec('loop1', 'CNAME', 'loop2.example.com'), // 11
		rec('loop2', 'CNAME', 'loop1.example.com') // 12
	];
};

const site = (host: string): SiteUse => ({ host, href: null, disabled: false });
const ids = (records: DnsRecord[]) => records.map((r) => r.id).sort((a, b) => Number(a) - Number(b));

describe('siteHostOf', () => {
	it.each([
		['example.com', 'example.com'],
		['https://App.Example.com', 'app.example.com'],
		['http://app.example.com:8080', 'app.example.com'],
		['app.example.com:443', 'app.example.com'],
		['app.example.com/api/*', 'app.example.com'],
		['*.example.com', '*.example.com'],
		['example.com.', 'example.com']
	])('reads %s as %s', (address, host) => {
		expect(siteHostOf(address)).toBe(host);
	});

	it.each([
		':8080',
		'localhost',
		'localhost:8080',
		'192.0.2.1',
		'192.0.2.1:80',
		'[::1]:443',
		'{$DOMAIN}',
		'http://'
	])('finds no host in %s', (address) => {
		expect(siteHostOf(address)).toBeNull();
	});
});

describe('sitesInDomain', () => {
	it('keeps the addresses under the domain, once each, with a link to the site', () => {
		const sites = sitesInDomain(
			[
				{ id: 'one', addresses: ['www.example.com', 'example.com', 'other.test'], disabled: false },
				{ id: 'two', addresses: ['https://www.example.com', 'shop.example.com:8443'], disabled: true },
				{ id: null, addresses: ['notexample.com', ':80'], disabled: false }
			],
			D
		);
		expect(sites).toEqual([
			{ host: 'www.example.com', href: '/sites/one', disabled: false },
			{ host: 'example.com', href: '/sites/one', disabled: false },
			{ host: 'shop.example.com', href: '/sites/two', disabled: true }
		]);
	});
});

describe('recordsBehind', () => {
	it('finds the address records at the name itself', () => {
		expect(ids(recordsBehind('example.com', zone(), D))).toEqual(['1']);
	});

	it('follows a CNAME inside the zone to what it points at', () => {
		expect(ids(recordsBehind('www.example.com', zone(), D))).toEqual(['1', '3']);
	});

	it('stops at a CNAME that leaves the zone', () => {
		expect(ids(recordsBehind('blog.example.com', zone(), D))).toEqual(['5']);
	});

	it('falls back to the wildcard for a name with no records', () => {
		expect(ids(recordsBehind('shop.example.com', zone(), D))).toEqual(['4']);
	});

	it('does not let a wildcard answer for a name that has other records', () => {
		// mail.example.com exists (a TXT record), so *.example.com does not cover it.
		expect(recordsBehind('mail.example.com', zone(), D)).toEqual([]);
	});

	it('uses the wildcard of the closest name that exists', () => {
		// deep.example.com exists because names sit below it, so its own wildcard is the one that counts.
		expect(ids(recordsBehind('b.deep.example.com', zone(), D))).toEqual(['10']);
		expect(ids(recordsBehind('x.y.example.com', zone(), D))).toEqual(['4']);
	});

	it('matches a wildcard site to the wildcard record', () => {
		expect(ids(recordsBehind('*.example.com', zone(), D))).toEqual(['4']);
	});

	it('does not run in circles', () => {
		expect(ids(recordsBehind('loop1.example.com', zone(), D))).toEqual(['11', '12']);
	});
});

describe('markRecords', () => {
	it('marks challenge records and the records sites resolve through', () => {
		const z = zone();
		const marks = markRecords(z, [site('www.example.com'), site('example.com'), site('shop.example.com')], D);
		expect(Object.keys(marks).sort((a, b) => Number(a) - Number(b))).toEqual(['1', '3', '4', '7', '8']);
		expect(marks['1']?.sites.map((s) => s.host)).toEqual(['www.example.com', 'example.com']);
		expect(marks['3']?.sites.map((s) => s.host)).toEqual(['www.example.com']);
		expect(marks['4']?.sites.map((s) => s.host)).toEqual(['shop.example.com']);
		expect(marks['7']).toEqual({ managedByCaddy: true, sites: [] });
	});

	it('knows a challenge record by its name and type', () => {
		expect(isAcmeChallenge({ host: '_acme-challenge', type: 'TXT' })).toBe(true);
		expect(isAcmeChallenge({ host: '_acme-challenge.www', type: 'TXT' })).toBe(true);
		expect(isAcmeChallenge({ host: '_acme-challenge', type: 'CNAME' })).toBe(false);
		expect(isAcmeChallenge({ host: 'x._acme-challenge', type: 'TXT' })).toBe(false);
	});
});

describe('marksFromCaddy', () => {
	const known = [{ host: 'www.example.com', href: '/sites/one', disabled: false }];

	it('takes the pairs of sites and records from the tie-in', () => {
		const marks = marksFromCaddy(
			{
				plugin: true,
				sites: [
					{ host: 'www.example.com', dns01: true, records: [{ id: '3' }, { id: 1 }, { id: '999' }] },
					{ host: 'api.example.com', siteId: 'api.example.com', records: [{ id: '4', domain: D }] },
					{ host: 'no-link.example.com', siteId: '', records: [{ id: '9' }] }
				]
			},
			zone(),
			known,
			D
		);
		expect(marks?.['3']?.sites).toEqual(known);
		expect(marks?.['1']?.sites).toEqual(known);
		// A site the Caddyfile scan did not list gets its link from the tie-in.
		expect(marks?.['4']?.sites).toEqual([
			{ host: 'api.example.com', href: '/sites/api.example.com', disabled: false }
		]);
		expect(marks?.['9']?.sites).toEqual([{ host: 'no-link.example.com', href: null, disabled: false }]);
		expect(marks?.['7']?.managedByCaddy).toBe(true);
		expect(marks?.['999']).toBeUndefined();
	});

	it('marks a site of another domain that resolves through this zone, and no record of another zone', () => {
		const marks = marksFromCaddy(
			{
				sites: [
					{
						host: 'shop.example.net',
						siteId: 'shop.example.net',
						// A CNAME in the other zone, then the record it points at here.
						records: [
							{ id: '4', domain: 'example.net' },
							{ id: '1', domain: D }
						]
					}
				]
			},
			zone(),
			known,
			D
		);
		expect(marks?.['1']?.sites.map((s) => s.host)).toEqual(['shop.example.net']);
		// Record 4 of this zone only shares its id with the one in example.net.
		expect(marks?.['4']).toBeUndefined();
	});

	it('is null when the tie-in could not read the zone, so the marks are worked out here', () => {
		const unreadable = { host: 'www.example.com', status: 'unreadable', records: [] };
		expect(marksFromCaddy({ sites: [unreadable] }, zone(), known, D)).toBeNull();
		// A zone further along a CNAME that can not be read leaves the pairs found in this one.
		const further = { host: 'blog.example.com', status: 'unreadable', records: [{ id: '5', domain: D }] };
		expect(marksFromCaddy({ sites: [further] }, zone(), known, D)?.['5']?.sites.map((s) => s.host)).toEqual([
			'blog.example.com'
		]);
		// Another domain's trouble is not this page's.
		const other = { host: 'www.example.net', status: 'unreadable', records: [] };
		expect(marksFromCaddy({ sites: [other] }, zone(), known, D)).not.toBeNull();
	});

	it.each([
		null,
		undefined,
		'text',
		{},
		{ sites: 'no' },
		{ sites: [{ host: 1 }] },
		{ sites: [{ host: 'a.example.com' }] }
	])('is null for a shape it does not read: %j', (payload) => {
		expect(marksFromCaddy(payload, zone(), known, D)).toBeNull();
	});
});

describe('dependents', () => {
	it('says which sites a record takes with it', () => {
		expect(dependents({ managedByCaddy: false, sites: [site('www.example.com')] }, 'delete')).toBe(
			'Used by the site www.example.com: without this record it can not be reached.'
		);
		expect(
			dependents(
				{ managedByCaddy: false, sites: ['a', 'b', 'c', 'd', 'e'].map((h) => site(`${h}.example.com`)) },
				'edit'
			)
		).toBe(
			'Used by the sites a.example.com, b.example.com, c.example.com and 2 more: with a wrong value here they can not be reached.'
		);
	});

	it('says a challenge record is Caddy’s own, and nothing for a record nobody depends on', () => {
		expect(dependents({ managedByCaddy: true, sites: [] }, 'delete')).toMatch(/^Managed by Caddy/);
		expect(dependents(undefined, 'delete')).toBeNull();
		expect(dependents({ managedByCaddy: false, sites: [] }, 'edit')).toBeNull();
	});
});
