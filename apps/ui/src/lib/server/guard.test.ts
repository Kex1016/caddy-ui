import { describe, expect, it } from 'vitest';
import { isApiPath, isHttps, isPublicPath, sameOrigin } from './guard';

describe('paths', () => {
	it('keeps only health, login and assets public', () => {
		expect(isPublicPath('/api/health')).toBe(true);
		expect(isPublicPath('/login')).toBe(true);
		expect(isPublicPath('/_app/immutable/x.js')).toBe(true);
		expect(isPublicPath('/favicon.svg')).toBe(true);
		expect(isPublicPath('/')).toBe(false);
		expect(isPublicPath('/api/caddyfile')).toBe(false);
		expect(isPublicPath('/api/health/x')).toBe(false);
		expect(isPublicPath('/login/x')).toBe(false);
	});
	it('recognises API paths', () => {
		expect(isApiPath('/api')).toBe(true);
		expect(isApiPath('/api/sites')).toBe(true);
		expect(isApiPath('/apidocs')).toBe(false);
	});
});

describe('sameOrigin', () => {
	const h = (init: Record<string, string>) => new Headers(init);
	it('allows safe methods regardless of origin', () => {
		expect(sameOrigin('GET', h({ origin: 'https://evil.example', host: 'ui:3001' }))).toBe(true);
	});
	it('allows a same-host origin over http or https', () => {
		expect(sameOrigin('POST', h({ origin: 'http://10.0.0.5:9876', host: '10.0.0.5:9876' }))).toBe(true);
		expect(sameOrigin('PUT', h({ origin: 'https://caddy.example.com', host: 'caddy.example.com' }))).toBe(
			true
		);
	});
	it('allows the forwarded host behind a proxy', () => {
		expect(
			sameOrigin(
				'POST',
				h({
					origin: 'https://caddy.example.com',
					host: 'caddy-ui:3001',
					'x-forwarded-host': 'caddy.example.com'
				})
			)
		).toBe(true);
	});
	it('refuses cross-site and opaque origins', () => {
		expect(sameOrigin('POST', h({ origin: 'https://evil.example', host: 'caddy.example.com' }))).toBe(false);
		expect(sameOrigin('DELETE', h({ origin: 'null', host: 'caddy.example.com' }))).toBe(false);
		expect(sameOrigin('POST', h({ origin: 'not a url', host: 'caddy.example.com' }))).toBe(false);
	});
	it('allows non-browser clients that send no Origin', () => {
		expect(sameOrigin('POST', h({ host: 'caddy.example.com' }))).toBe(true);
	});
});

describe('isHttps', () => {
	it('trusts the proxy header first', () => {
		expect(isHttps(new Headers({ 'x-forwarded-proto': 'https' }), undefined)).toBe(true);
		expect(isHttps(new Headers({ 'x-forwarded-proto': 'http' }), 'https://ui.example.com')).toBe(false);
		expect(isHttps(new Headers({ 'x-forwarded-proto': 'https, http' }), undefined)).toBe(true);
	});
	it('falls back to the public URL, then to http', () => {
		expect(isHttps(new Headers(), 'https://ui.example.com')).toBe(true);
		expect(isHttps(new Headers(), 'http://ui.example.com')).toBe(false);
		expect(isHttps(new Headers(), undefined)).toBe(false);
	});
});
