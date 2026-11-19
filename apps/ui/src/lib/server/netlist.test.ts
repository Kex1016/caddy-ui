import { describe, expect, it } from 'vitest';
import { defaultGateway, NetworkMatcher, parseNetworks } from './netlist';

describe('networks', () => {
	it('parses addresses and ranges separated by commas or spaces', () => {
		expect(parseNetworks('127.0.0.0/8, ::1  172.16.0.0/12,fd00::/8')).toEqual([
			{ address: '127.0.0.0', prefix: 8, family: 'ipv4' },
			{ address: '::1', prefix: 128, family: 'ipv6' },
			{ address: '172.16.0.0', prefix: 12, family: 'ipv4' },
			{ address: 'fd00::', prefix: 8, family: 'ipv6' }
		]);
		expect(parseNetworks('  ')).toEqual([]);
	});

	it('names the entry it cannot read', () => {
		expect(() => parseNetworks('172.16.0.0/12, docker')).toThrow(/"docker" is not an IP address/);
		expect(() => parseNetworks('10.0.0.0/33')).toThrow(/prefix outside 0 to 32/);
		expect(() => parseNetworks('::/129')).toThrow(/prefix outside 0 to 128/);
		expect(() => parseNetworks('10.0.0.0/')).toThrow(/prefix/);
	});

	it('matches IPv4, IPv6, IPv4-mapped IPv6, brackets and zones', () => {
		const m = new NetworkMatcher(parseNetworks('127.0.0.0/8, ::1, 172.16.0.0/12, fe80::/10'));
		for (const ip of [
			'172.17.0.1',
			'172.31.255.254',
			'127.0.0.1',
			'::ffff:172.18.0.3',
			'[::1]',
			'fe80::1%eth0'
		]) {
			expect(m.has(ip), ip).toBe(true);
		}
		for (const ip of [
			'172.32.0.1',
			'172.15.255.255',
			'10.0.0.7',
			'192.168.1.2',
			'2001:db8::1',
			'',
			'garbage'
		]) {
			expect(m.has(ip), ip).toBe(false);
		}
	});

	it('an empty list matches nothing', () => {
		expect(new NetworkMatcher([]).has('127.0.0.1')).toBe(false);
	});

	it('reads the default gateway from a Linux routing table', () => {
		const head = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n';
		expect(defaultGateway(head + 'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\n')).toBe('172.18.0.1');
		expect(defaultGateway(head + 'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n')).toBeNull();
		expect(defaultGateway('')).toBeNull();
	});
});
