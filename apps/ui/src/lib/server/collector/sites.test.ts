import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostMatcher, parseAddress, probeTarget, scanCaddyfile, siteId, upstreamTarget } from './sites';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'Caddyfile'), 'utf8');

describe('scanCaddyfile', () => {
	const sites = scanCaddyfile(fixture);

	it('finds every site block and skips the global block, snippets and comments', () => {
		expect(sites.map((s) => s.addresses)).toEqual([
			['app.example.com'],
			['media.example.com', 'tv.example.com'],
			['files.example.com', 'share.example.com'],
			['static.example.com'],
			['*.wild.example.com'],
			[':8080']
		]);
	});

	it('collects upstreams from args, `to`, imported snippets and nested blocks', () => {
		const ups = (i: number) => sites[i]?.upstreams.map((u) => `${u.via} ${u.address}`);
		expect(ups(0)).toEqual(['reverse_proxy 10.0.0.10:8080']);
		expect(ups(1)).toEqual([
			'forward_auth 10.0.0.101:8888',
			'reverse_proxy 10.0.0.20:8096',
			'reverse_proxy 10.0.0.21:8096'
		]);
		expect(ups(2)).toEqual(['reverse_proxy https://10.0.0.30:9443']);
		expect(ups(3)).toEqual([]);
		expect(ups(4)).toEqual([]); // placeholder upstream cannot be probed
		expect(ups(5)).toEqual(['reverse_proxy localhost:3000']);
	});

	it('records the line of each block', () => {
		expect(sites[0]?.line).toBe(fixture.split('\n').indexOf('app.example.com {') + 1);
	});

	it('handles a Caddyfile with one site and no braces', () => {
		const s = scanCaddyfile('localhost\n\nreverse_proxy 127.0.0.1:9000\n');
		expect(s).toHaveLength(1);
		expect(s[0]?.upstreams.map((u) => u.address)).toEqual(['127.0.0.1:9000']);
	});
});

describe('quoted braces and heredocs', () => {
	it('does not end a block at a brace inside a string', () => {
		const s = scanCaddyfile(
			'a.example.com {\n\trespond "}" 200\n\treverse_proxy 10.0.0.1:80\n}\nb.example.com {\n}\n'
		);
		expect(s.map((x) => x.addresses)).toEqual([['a.example.com'], ['b.example.com']]);
		expect(s[0]?.upstreams.map((u) => u.address)).toEqual(['10.0.0.1:80']);
	});
});

describe('siteId', () => {
	it('ignores order, case and whitespace of the address list', () => {
		expect(siteId(['B.example.com', ' a.example.com'])).toBe(siteId(['a.example.com', 'b.example.com']));
		expect(siteId(['a.example.com'])).not.toBe(siteId(['b.example.com']));
		expect(siteId(['a.example.com'])).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe('addresses and targets', () => {
	it('parses address forms', () => {
		expect(parseAddress('https://Example.com:8443/api*')).toEqual({
			scheme: 'https',
			host: 'example.com',
			port: 8443,
			path: '/api*'
		});
		expect(parseAddress(':8080')).toEqual({ scheme: undefined, host: '', port: 8080, path: undefined });
	});

	it('probes through Caddy with the site name as Host and SNI', () => {
		expect(probeTarget(['app.example.com'], 'caddy')).toEqual({
			url: 'https://caddy/',
			hostHeader: 'app.example.com',
			servername: 'app.example.com'
		});
		expect(probeTarget(['http://app.example.com'], 'caddy')).toEqual({
			url: 'http://caddy/',
			hostHeader: 'app.example.com',
			servername: undefined
		});
		expect(probeTarget(['*.example.com', 'b.example.com:8443'], 'caddy')).toEqual({
			url: 'https://caddy:8443/',
			hostHeader: 'b.example.com:8443',
			servername: 'b.example.com'
		});
		expect(probeTarget([':8080'], 'caddy')).toEqual({ url: 'http://caddy:8080/' });
		expect(probeTarget(['*.example.com'], 'caddy')).toBeUndefined();
	});

	it('resolves upstream addresses with Caddy defaults', () => {
		expect(upstreamTarget('10.0.0.5:8080')).toEqual({ host: '10.0.0.5', port: 8080, scheme: undefined });
		expect(upstreamTarget('10.0.0.5')).toEqual({ host: '10.0.0.5', port: 80, scheme: undefined });
		expect(upstreamTarget('https://10.0.0.5')).toEqual({ host: '10.0.0.5', port: 443, scheme: 'https' });
		expect(upstreamTarget('h2c://10.0.0.5:9000')).toEqual({ host: '10.0.0.5', port: 9000, scheme: 'http' });
		expect(upstreamTarget('srv+http://x')).toBeUndefined();
	});
});

describe('HostMatcher', () => {
	const m = new HostMatcher(scanCaddyfile(fixture));
	const sites = scanCaddyfile(fixture);
	it('matches exact hosts, ports stripped', () => {
		expect(m.match('tv.example.com:443')).toBe(sites[1]?.id);
		expect(m.match('APP.example.com')).toBe(sites[0]?.id);
	});
	it('matches one-label wildcards only', () => {
		expect(m.match('x.wild.example.com')).toBe(sites[4]?.id);
		expect(m.match('a.b.wild.example.com')).toBeUndefined();
		expect(m.match('anything.test:8080')).toBe(sites[5]?.id); // the :8080 block serves any host on 8080
	});
});
