import { describe, expect, it } from 'vitest';
import { checkForward, describeForward, forwardSource, isForwardId } from './forwards';

const good = {
	subdomain: 'WWW',
	location: 'https://example.org/landing',
	redirectType: '301',
	includePath: true,
	wildcard: false
};

describe('checkForward', () => {
	it('accepts a normal forward and folds the subdomain to lower case', () => {
		expect(checkForward(good)).toEqual({ ok: true, value: { ...good, subdomain: 'www' } });
	});

	it('accepts the apex and nested names', () => {
		expect(checkForward({ ...good, subdomain: '' }).ok).toBe(true);
		expect(checkForward({ ...good, subdomain: 'a.b-c' }).ok).toBe(true);
	});

	it.each(['*', '-a', 'a-', 'a..b', 'a b', 'ex.com/x', 'x'.repeat(64)])(
		'refuses subdomain %j',
		(subdomain) => {
			expect(checkForward({ ...good, subdomain }).ok).toBe(false);
		}
	);

	it.each([
		'',
		'example.org',
		'ftp://example.org',
		'javascript:alert(1)',
		'https://',
		'https://user:pw@example.org'
	])('refuses destination %j', (location) => {
		expect(checkForward({ ...good, location }).ok).toBe(false);
	});

	it('refuses an unknown type and non-boolean flags', () => {
		expect(checkForward({ ...good, redirectType: '308' }).ok).toBe(false);
		expect(checkForward({ ...good, includePath: 'yes' }).ok).toBe(false);
		expect(checkForward({ ...good, wildcard: undefined }).ok).toBe(false);
		expect(checkForward(null).ok).toBe(false);
	});
});

describe('wording', () => {
	it('names the source and the whole change', () => {
		expect(forwardSource({ subdomain: '' }, 'example.com')).toBe('example.com');
		expect(forwardSource({ subdomain: 'www' }, 'example.com')).toBe('www.example.com');
		expect(
			describeForward(
				{
					subdomain: 'www',
					location: 'https://example.org',
					redirectType: 'masked',
					includePath: false,
					wildcard: true
				},
				'example.com'
			)
		).toBe('www.example.com and every subdomain → https://example.org (masked)');
	});

	it('only lets safe ids through to a URL path', () => {
		expect(isForwardId('123')).toBe(true);
		expect(isForwardId('../x')).toBe(false);
		expect(isForwardId('')).toBe(false);
	});
});
