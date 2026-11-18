import { describe, expect, it } from 'vitest';
import { DNS_RECORD_TYPES, isKnownRecordType, writeBlock } from '$lib/api/porkbun';
import { NAV, pageTitle } from '$lib/nav';
import { explain } from './messages';
import { DOMAIN_TABS, currentTab, domainHref } from './tabs';

describe('navigation', () => {
	it('lists Domains between Sites and the Caddyfile group', () => {
		expect(NAV[0]?.items.map((i) => i.href)).toEqual(['/', '/sites', '/domains']);
		expect(NAV[1]?.label).toBe('Caddyfile');
		expect(NAV.flatMap((g) => g.items)).toHaveLength(8);
	});

	it('titles every Domains page "Domains"', () => {
		expect(pageTitle('/domains')).toBe('Domains');
		expect(pageTitle('/domains/example.com/dns')).toBe('Domains');
	});
});

describe('domain tabs', () => {
	it('are the seven in the plan, in order', () => {
		expect(DOMAIN_TABS.map((t) => t.label)).toEqual([
			'Overview',
			'DNS',
			'History',
			'Registry',
			'Forwarding',
			'SSL',
			'Caddy'
		]);
	});

	it('build their links from the domain', () => {
		expect(domainHref('example.com')).toBe('/domains/example.com');
		expect(domainHref('example.com', 'dns')).toBe('/domains/example.com/dns');
		expect(domainHref('a/b?c')).toBe('/domains/a%2Fb%3Fc');
	});

	it('find the tab a path is on', () => {
		expect(currentTab('/domains/example.com')).toBe('');
		expect(currentTab('/domains/example.com/dns')).toBe('dns');
		expect(currentTab('/domains/example.com/dns/import')).toBe('dns');
		expect(currentTab('/domains/example.com/unknown')).toBe('');
	});
});

describe('writeBlock', () => {
	const ok = { state: 'ok', readonly: false, scopes: ['read', 'dns'] } as const;

	it('allows a write the key may do', () => {
		expect(writeBlock({ ...ok, scopes: [...ok.scopes] }, 'dns')).toBeNull();
	});

	it('blocks everything in read-only mode, whatever the key may do', () => {
		expect(writeBlock({ ...ok, scopes: [...ok.scopes], readonly: true }, 'dns')).toMatchObject({
			code: 'READ_ONLY'
		});
	});

	it('blocks a write outside the key scopes and names the scope', () => {
		const block = writeBlock({ ...ok, scopes: [...ok.scopes] }, 'domains');
		expect(block?.code).toBe('INSUFFICIENT_SCOPE');
		expect(block?.message).toContain('"domains"');
	});

	it('does not guess the scopes while Porkbun has not been asked', () => {
		expect(writeBlock({ state: 'error', readonly: false, scopes: [] }, 'domains')).toBeNull();
	});

	it('blocks when the keys are not set', () => {
		expect(writeBlock({ state: 'off', readonly: false, scopes: [] }, 'dns')?.code).toBe('NOT_CONFIGURED');
		expect(writeBlock({ state: 'misconfigured', readonly: false, scopes: [] }, 'dns')?.code).toBe(
			'NOT_CONFIGURED'
		);
	});
});

describe('record types', () => {
	it('knows the fourteen Porkbun edits and nothing else', () => {
		expect(DNS_RECORD_TYPES).toHaveLength(14);
		expect(isKnownRecordType('HTTPS')).toBe(true);
		expect(isKnownRecordType('SOA')).toBe(false);
		expect(isKnownRecordType('a')).toBe(false);
	});
});

describe('explain', () => {
	it.each([
		'API_ACCESS_DISABLED',
		'DOMAIN_NOT_ALLOWED',
		'IP_NOT_ALLOWED',
		'INSUFFICIENT_SCOPE',
		'ZONE_RECORD_LIMIT'
	])('says what to change at Porkbun for %s', (code) => {
		const info = explain({ code, retryable: false });
		expect(info.title).not.toMatch(/refused the request/);
		expect(info.fix).toBeTruthy();
	});

	it('falls back to a neutral title for a code it does not know', () => {
		expect(explain({ code: 'SOMETHING_NEW', retryable: false }).title).toBe('Porkbun refused the request.');
		expect(explain({ code: 'SOMETHING_NEW', retryable: true }).title).toBe(
			'Porkbun could not do that just now.'
		);
	});
});
