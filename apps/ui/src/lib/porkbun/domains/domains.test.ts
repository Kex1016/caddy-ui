import { describe, expect, it } from 'vitest';
import {
	daysUntil,
	describeTypes,
	expiryState,
	formatCents,
	formatCountdown,
	formatUsd,
	matchesFilter,
	matchesQuery,
	sortDomains,
	summariseNameservers,
	type DomainRow
} from './index';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY = 86_400_000;
const iso = (days: number) => new Date(NOW + days * DAY).toISOString();

const row = (domain: string, patch: Partial<DomainRow> = {}): DomainRow => ({
	domain,
	tld: domain.split('.').slice(1).join('.'),
	status: 'ACTIVE',
	createDate: '2020-01-01T00:00:00.000Z',
	expireDate: iso(400),
	autoRenew: true,
	securityLock: true,
	whoisPrivacy: true,
	apiAccess: true,
	notLocal: false,
	labels: [],
	renewal: '10.00',
	...patch
});

describe('expiry', () => {
	it('counts whole days and says expired once the date has passed', () => {
		expect(daysUntil(iso(12.5), NOW)).toBe(12);
		expect(daysUntil(iso(-0.5), NOW)).toBe(-1);
		expect(daysUntil('', NOW)).toBeNull();
		expect(daysUntil('not a date', NOW)).toBeNull();
		expect(expiryState(-1)).toBe('expired');
		expect(expiryState(0)).toBe('soon');
		expect(expiryState(30)).toBe('soon');
		expect(expiryState(31)).toBe('ok');
		expect(expiryState(null)).toBe('unknown');
	});

	it('words the countdown in days, then months, then years', () => {
		expect(formatCountdown(0)).toBe('today');
		expect(formatCountdown(1)).toBe('in 1 day');
		expect(formatCountdown(59)).toBe('in 59 days');
		expect(formatCountdown(61)).toBe('in 2 months');
		expect(formatCountdown(400)).toBe('in 13 months');
		expect(formatCountdown(800)).toBe('in 2 years');
		expect(formatCountdown(-3)).toBe('3 days ago');
		expect(formatCountdown(null)).toBe('unknown');
	});
});

describe('filters and search', () => {
	const rows = [
		row('soon.com', { expireDate: iso(10) }),
		row('gone.com', { expireDate: iso(-2) }),
		row('off.net', { autoRenew: false }),
		row('closed.org', { apiAccess: false, labels: [{ id: '1', title: 'Homelab', color: '#000' }] })
	];
	const names = (f: Parameters<typeof matchesFilter>[1]) =>
		rows.filter((r) => matchesFilter(r, f, NOW)).map((r) => r.domain);

	it('keeps what each filter names', () => {
		expect(names('all')).toHaveLength(4);
		expect(names('soon')).toEqual(['soon.com', 'gone.com']);
		expect(names('renew-off')).toEqual(['off.net']);
		expect(names('renew-on')).toEqual(['soon.com', 'gone.com', 'closed.org']);
		expect(names('api-off')).toEqual(['closed.org']);
	});

	it('searches names and label titles, ignoring case', () => {
		expect(rows.filter((r) => matchesQuery(r, 'NET')).map((r) => r.domain)).toEqual(['off.net']);
		expect(rows.filter((r) => matchesQuery(r, 'homelab')).map((r) => r.domain)).toEqual(['closed.org']);
		expect(rows.filter((r) => matchesQuery(r, '  ')).length).toBe(4);
	});
});

describe('sortDomains', () => {
	const rows = [
		row('b.com', { expireDate: iso(5), renewal: '30.00' }),
		row('a.com', { expireDate: '', renewal: null }),
		row('c.com', { expireDate: iso(1), renewal: '9.50' })
	];
	const order = (key: 'domain' | 'expires' | 'renewal', dir: 'asc' | 'desc') =>
		sortDomains(rows, { key, dir }).map((r) => r.domain);

	it('sorts by name, expiry and price, with unknowns last both ways', () => {
		expect(order('domain', 'asc')).toEqual(['a.com', 'b.com', 'c.com']);
		expect(order('domain', 'desc')).toEqual(['c.com', 'b.com', 'a.com']);
		expect(order('expires', 'asc')).toEqual(['c.com', 'b.com', 'a.com']);
		expect(order('expires', 'desc')).toEqual(['b.com', 'c.com', 'a.com']);
		expect(order('renewal', 'asc')).toEqual(['c.com', 'b.com', 'a.com']);
		expect(order('renewal', 'desc')).toEqual(['b.com', 'c.com', 'a.com']);
	});

	it('does not change the array it is given', () => {
		const before = rows.map((r) => r.domain);
		sortDomains(rows, { key: 'expires', dir: 'asc' });
		expect(rows.map((r) => r.domain)).toEqual(before);
	});
});

describe('summaries', () => {
	it("tells Porkbun's nameservers from others and from a mix", () => {
		const ours = [
			'curitiba.ns.porkbun.com',
			'fortaleza.ns.porkbun.com',
			'maceio.ns.porkbun.com',
			'salvador.ns.porkbun.com'
		];
		expect(summariseNameservers(ours).kind).toBe('porkbun');
		expect(summariseNameservers(['ns1.example-dns.net', 'ns2.example-dns.net']).kind).toBe('custom');
		expect(summariseNameservers(['maceio.ns.porkbun.com', 'ns1.example-dns.net']).kind).toBe('mixed');
		expect(summariseNameservers(ours.slice(0, 2)).kind).toBe('mixed');
		expect(summariseNameservers([]).kind).toBe('none');
	});

	it('lists the commonest record types first and sums the rest', () => {
		expect(describeTypes({ TXT: 1, A: 4, MX: 2 })).toBe('4 A, 2 MX, 1 TXT');
		expect(describeTypes({ A: 1, AAAA: 1, CAA: 1, MX: 1, NS: 1, TXT: 2 }, 3)).toBe(
			'2 TXT, 1 A, 1 AAAA, 3 other'
		);
		expect(describeTypes({})).toBe('');
	});

	it('formats money', () => {
		expect(formatUsd('11.08')).toBe('$11.08');
		expect(formatUsd('9.5')).toBe('$9.50');
		expect(formatUsd(null)).toBe('—');
		expect(formatCents(2500)).toBe('$25.00');
		expect(formatCents(null)).toBe('—');
	});
});
