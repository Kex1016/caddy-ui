import { describe, expect, it } from 'vitest';
import { PORKBUN_NAMESERVERS } from '$lib/api/porkbun';
import {
	checkDnssec,
	checkGlueHost,
	checkGlueIps,
	checkNameservers,
	confirms,
	isAtPorkbun,
	isIPv4,
	isIPv6,
	isPorkbunDefault,
	parseDsText,
	sameNameservers
} from './validate';

describe('nameservers', () => {
	it('takes a pasted list and normalises it', () => {
		expect(checkNameservers('NS1.Example-DNS.net.\nns2.example-dns.net, ns3.example-dns.net')).toEqual({
			ok: true,
			value: ['ns1.example-dns.net', 'ns2.example-dns.net', 'ns3.example-dns.net']
		});
	});

	it('refuses fewer than two, more than thirteen, duplicates and non-hostnames', () => {
		expect(checkNameservers(['ns1.example.net']).ok).toBe(false);
		expect(checkNameservers(Array.from({ length: 14 }, (_, i) => `ns${i}.example.net`)).ok).toBe(false);
		expect(checkNameservers(['ns1.example.net', 'NS1.example.net.']).ok).toBe(false);
		expect(checkNameservers(['ns1.example.net', '192.0.2.1']).ok).toBe(false);
		expect(checkNameservers(['ns1.example.net', 'localhost']).ok).toBe(false);
		expect(checkNameservers(42).ok).toBe(false);
	});

	it('compares sets and recognises Porkbun', () => {
		expect(sameNameservers(['A.example.', 'b.example'], ['b.example', 'a.example'])).toBe(true);
		expect(sameNameservers(['a.example'], ['a.example', 'b.example'])).toBe(false);
		expect(isPorkbunDefault([...PORKBUN_NAMESERVERS].reverse())).toBe(true);
		expect(isPorkbunDefault(PORKBUN_NAMESERVERS.slice(0, 2))).toBe(false);
		expect(isAtPorkbun(PORKBUN_NAMESERVERS.slice(0, 2))).toBe(true);
		expect(isAtPorkbun(['ns1.example-dns.net', 'maceio.ns.porkbun.com'])).toBe(false);
		expect(isAtPorkbun([])).toBe(false);
	});
});

describe('glue', () => {
	it('takes the host short or in full', () => {
		expect(checkGlueHost('ns1', 'example.com')).toEqual({ ok: true, value: 'ns1' });
		expect(checkGlueHost('NS1.example.com.', 'example.com')).toEqual({ ok: true, value: 'ns1' });
		expect(checkGlueHost('ns1.eu.example.com', 'example.com')).toEqual({ ok: true, value: 'ns1.eu' });
	});

	it('refuses names outside the domain, the domain itself and bad labels', () => {
		for (const h of ['ns1.other.test', 'example.com', '-ns', 'ns_1', '', 'a b']) {
			expect(checkGlueHost(h, 'example.com').ok, h).toBe(false);
		}
	});

	it('checks addresses', () => {
		expect(checkGlueIps('192.0.2.1 2001:DB8::1')).toEqual({ ok: true, value: ['192.0.2.1', '2001:db8::1'] });
		for (const ips of ['', '192.0.2.256', '192.0.2.1 192.0.2.1', 'ns1.example.com']) {
			expect(checkGlueIps(ips).ok, ips).toBe(false);
		}
	});

	it('knows an IPv4 and an IPv6 address when it sees one', () => {
		for (const ip of ['0.0.0.0', '203.0.113.10', '255.255.255.255']) expect(isIPv4(ip), ip).toBe(true);
		for (const ip of ['01.2.3.4', '1.2.3', '1.2.3.4.5', '256.1.1.1']) expect(isIPv4(ip), ip).toBe(false);
		for (const ip of ['::', '::1', '2001:db8::', '2001:db8:0:0:0:0:0:1', 'fe80::1:2', '::ffff:192.0.2.1']) {
			expect(isIPv6(ip), ip).toBe(true);
		}
		for (const ip of [
			'2001:db8:::1',
			'1:2:3:4:5:6:7:8:9',
			'1:2:3:4:5:6:7',
			'g::1',
			'1::2::3',
			'::ffff:1.2.3'
		]) {
			expect(isIPv6(ip), ip).toBe(false);
		}
	});
});

describe('DNSSEC', () => {
	const DS = { keyTag: '2371', alg: '13', digestType: '2', digest: '49fd46e6'.repeat(8) };

	it('accepts a DS record and upper-cases the digest', () => {
		const out = checkDnssec({ ...DS, keyTag: 2371 });
		expect(out).toEqual({ ok: true, value: { ...DS, digest: DS.digest.toUpperCase() } });
	});

	it('names every bad field', () => {
		const out = checkDnssec({ keyTag: 'x', alg: '7', digestType: '2', digest: 'ABC' });
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(Object.keys(out.fields).sort()).toEqual(['alg', 'digest', 'keyTag']);
		expect(out.fields.alg).toContain('retired');
		expect(out.fields.digest).toContain('64');
	});

	it('wants all of the key data or none', () => {
		expect(checkDnssec({ ...DS, keyDataFlags: '257' }).ok).toBe(false);
		const full = checkDnssec({
			...DS,
			keyDataFlags: '257',
			keyDataProtocol: '3',
			keyDataAlgo: '13',
			keyDataPubKey:
				'mdsswUyr3DPW132mOi8V9xESWE8jTo0dxCjjnopKl+GqJxpVXckHAeF+KkxLbxILfDLUT0rAK9iUzy1L53eKGQ=='
		});
		expect(full.ok).toBe(true);
	});

	it('reads a DS record as providers print it', () => {
		expect(
			parseDsText(`example.com. 3600 IN DS 2371 13 2 ${DS.digest.slice(0, 32)} ${DS.digest.slice(32)}`)
		).toEqual({
			...DS,
			digest: DS.digest.toUpperCase()
		});
		expect(parseDsText('2371 13 2 ABCD')).toMatchObject({ keyTag: '2371', digest: 'ABCD' });
		expect(parseDsText('hello world')).toBeNull();
	});
});

it('confirms the typed domain without regard to case or spaces', () => {
	expect(confirms(' Example.COM ', 'example.com')).toBe(true);
	expect(confirms('example.net', 'example.com')).toBe(false);
	expect(confirms(undefined, 'example.com')).toBe(false);
});
