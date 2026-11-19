import { describe, expect, it } from 'vitest';
import type { DnsRecord } from '$lib/api/porkbun';
import { answersFor, canonicalIp, domainOf, hostLabel, isPrivateIp, resolveName, sameIp } from './resolve';

let next = 1;
const rec = (domain: string, host: string, type: string, content: string): DnsRecord => ({
	id: String(next++),
	name: host === '' ? domain : `${host}.${domain}`,
	host,
	type,
	content,
	ttl: 600,
	prio: null,
	notes: null
});

const COM = [
	rec('example.com', '', 'A', '203.0.113.10'),
	rec('example.com', 'www', 'A', '203.0.113.10'),
	rec('example.com', '*', 'A', '203.0.113.20'),
	rec('example.com', 'sub', 'A', '203.0.113.30'),
	rec('example.com', 'note', 'TXT', 'hello'),
	rec('example.com', 'shop', 'CNAME', 'www.example.com'),
	rec('example.com', 'cdn', 'CNAME', 'edge.example.io.'),
	rec('example.com', 'net', 'CNAME', 'example.net'),
	rec('example.com', 'loop', 'CNAME', 'loop2.example.com'),
	rec('example.com', 'loop2', 'CNAME', 'loop.example.com'),
	rec('example.com', '*.dev', 'AAAA', '2001:db8::1')
];
const NET = [rec('example.net', '', 'ALIAS', 'www.example.com')];
const DOMAINS = ['example.com', 'example.net', 'sub.example.net'];
const zoneOf = async (d: string) => (d === 'example.com' ? COM : d === 'example.net' ? NET : null);
const resolve = (name: string) => resolveName(name, DOMAINS, zoneOf);
const answer = (name: string) => answersFor(name, 'example.com', COM);

describe('which account domain a name is under', () => {
	it('picks the longest match and ignores a wildcard label', () => {
		expect(domainOf('a.sub.example.net', DOMAINS)).toBe('sub.example.net');
		expect(domainOf('example.net', DOMAINS)).toBe('example.net');
		expect(domainOf('*.Example.com.', DOMAINS)).toBe('example.com');
		expect(domainOf('notexample.com', DOMAINS)).toBeNull();
		expect(domainOf('example.org', DOMAINS)).toBeNull();
	});

	it('splits a name into its host part', () => {
		expect(hostLabel('example.com', 'example.com')).toBe('');
		expect(hostLabel('a.b.example.com', 'example.com')).toBe('a.b');
		expect(hostLabel('*.example.com', 'example.com')).toBe('*');
	});
});

describe('answering from a zone the way a nameserver does', () => {
	it('prefers the records of the name itself', () => {
		expect(answer('www.example.com')).toMatchObject({
			viaWildcard: false,
			records: [{ content: '203.0.113.10' }]
		});
		expect(answer('example.com').records).toHaveLength(1);
		expect(answer('*.example.com')).toMatchObject({
			viaWildcard: false,
			records: [{ content: '203.0.113.20' }]
		});
	});

	it('falls back to the wildcard of the closest enclosing name', () => {
		expect(answer('app.example.com')).toMatchObject({
			viaWildcard: true,
			records: [{ content: '203.0.113.20' }]
		});
		expect(answer('a.b.example.com')).toMatchObject({
			viaWildcard: true,
			records: [{ content: '203.0.113.20' }]
		});
		expect(answer('x.dev.example.com')).toMatchObject({ viaWildcard: true, records: [{ type: 'AAAA' }] });
	});

	it('does not let a wildcard answer for a name that exists, or below a name that exists', () => {
		// `note` has only a TXT record: the name exists, so there is no address for it.
		expect(answer('note.example.com')).toEqual({ records: [], viaWildcard: false });
		// `sub` exists and has no wildcard of its own.
		expect(answer('deep.sub.example.com')).toEqual({ records: [], viaWildcard: false });
		// `dev` exists only because `*.dev` does; it has no address itself.
		expect(answer('dev.example.com')).toEqual({ records: [], viaWildcard: false });
	});
});

describe('following CNAME and ALIAS records', () => {
	it('ends at the address records, inside one zone or across the account', async () => {
		const shop = await resolve('shop.example.com');
		expect(shop.chain.map((r) => `${r.type} ${r.name}`)).toEqual([
			'CNAME shop.example.com',
			'A www.example.com'
		]);
		expect(shop).toMatchObject({ viaAlias: true, viaWildcard: false, external: null, unreadable: null });
		expect(shop.addresses.map((r) => r.content)).toEqual(['203.0.113.10']);

		const net = await resolve('example.net');
		expect(net.chain.map((r) => `${r.type} ${r.domain}`)).toEqual(['ALIAS example.net', 'A example.com']);
		const far = await resolve('net.example.com');
		expect(far.chain).toHaveLength(3);
		expect(far.addresses[0]?.content).toBe('203.0.113.10');
	});

	it('stops at a name outside the account, at an unreadable zone and at a loop', async () => {
		expect(await resolve('cdn.example.com')).toMatchObject({ external: 'edge.example.io', addresses: [] });
		expect(await resolve('x.sub.example.net')).toMatchObject({
			unreadable: 'sub.example.net',
			addresses: []
		});
		const loop = await resolve('loop.example.com');
		expect(loop.addresses).toEqual([]);
		expect(loop.chain).toHaveLength(2);
		expect(await resolve('nowhere.example.org')).toMatchObject({ external: null, chain: [] });
	});
});

describe('comparing addresses', () => {
	it('treats two spellings of one IPv6 address as equal', () => {
		expect(canonicalIp('2001:0DB8::0001')).toBe('2001:db8:0:0:0:0:0:1');
		expect(sameIp('2001:db8::1', '2001:db8:0:0:0:0:0:1')).toBe(true);
		expect(sameIp('::ffff:192.0.2.1', '0:0:0:0:0:ffff:c000:201')).toBe(true);
		expect(sameIp('203.0.113.10', '203.0.113.10 ')).toBe(true);
		expect(sameIp('203.0.113.10', '203.0.113.11')).toBe(false);
	});

	it.each([
		'10.0.0.5',
		'172.16.0.1',
		'172.31.255.1',
		'192.168.1.1',
		'127.0.0.1',
		'169.254.1.1',
		'100.64.0.1',
		'fd00::1',
		'fe80::1',
		'::1'
	])('%s is private', (ip) => expect(isPrivateIp(ip)).toBe(true));
	it.each(['203.0.113.10', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2001:db8::1'])('%s is public', (ip) =>
		expect(isPrivateIp(ip)).toBe(false)
	);
});
