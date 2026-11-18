import { describe, expect, it } from 'vitest';
import { readCaddyfile, siteHost } from './caddyfile';

const PORKBUN =
	'dns porkbun {\n\t\t\tapi_key {env.PORKBUN_API_KEY}\n\t\t\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}\n\t\t}';

describe('site addresses as host names', () => {
	it.each([
		['app.example.com', 'app.example.com', false, true],
		['https://App.Example.com:8443/api/*', 'app.example.com', false, true],
		['http://app.example.com', 'app.example.com', false, false],
		['app.example.com:80', 'app.example.com', false, false],
		['*.example.com', '*.example.com', true, true],
		['example.com.', 'example.com', false, true]
	])('%s', (address, host, wildcard, https) => {
		expect(siteHost(address)).toEqual({ address, host, wildcard, https });
	});

	it.each([
		':8080',
		'localhost',
		'app.localhost',
		'10.0.0.5',
		'10.0.0.5:443',
		'[::1]:443',
		'{$HOST}',
		'a.*.example.com',
		'intranet'
	])('%s is not one', (address) => {
		expect(siteHost(address)).toBeNull();
	});
});

describe('how each site gets its certificate', () => {
	const facts = (text: string) => readCaddyfile(text);
	const site = (text: string, i = 0) => facts(text).sites[i]!;

	it('reads addresses, line and hosts', () => {
		const s = site('# top\n\napp.example.com, https://www.example.com, :8080 {\n\trespond "ok"\n}\n');
		expect(s.addresses).toEqual(['app.example.com', 'https://www.example.com', ':8080']);
		expect(s.line).toBe(3);
		expect(s.hosts.map((h) => h.host)).toEqual(['app.example.com', 'www.example.com']);
		expect(s).toMatchObject({ certificate: 'acme', onDemand: false, dns01: null });
	});

	it('sees the DNS challenge in the site, with its provider', () => {
		expect(site(`*.example.com {\n\ttls {\n\t\t${PORKBUN}\n\t}\n}\n`).dns01).toEqual({
			source: 'site',
			provider: 'porkbun'
		});
		expect(site('a.example.com {\n\ttls {\n\t\tdns cloudflare {env.CF}\n\t}\n}\n').dns01).toEqual({
			source: 'site',
			provider: 'cloudflare'
		});
		expect(
			site('a.example.com {\n\ttls {\n\t\tissuer acme {\n\t\t\tdns porkbun {\n\t\t\t}\n\t\t}\n\t}\n}\n').dns01
		).toEqual({ source: 'site', provider: 'porkbun' });
	});

	it('follows imports into snippets', () => {
		const text = `(dns01) {\n\ttls {\n\t\t${PORKBUN}\n\t}\n}\n\n(outer) {\n\timport dns01\n}\n\na.example.com {\n\timport outer\n}\n\nb.example.com {\n\trespond "ok"\n}\n`;
		expect(site(text, 0).dns01).toEqual({ source: 'site', provider: 'porkbun' });
		expect(site(text, 1).dns01).toBeNull();
	});

	it('applies the global acme_dns option to every site that uses a public CA', () => {
		const text =
			'{\n\tacme_dns porkbun {\n\t\tapi_key {env.A}\n\t\tapi_secret_key {env.B}\n\t}\n}\n\n' +
			'a.example.com {\n}\n\nb.example.com {\n\ttls internal\n}\n\nc.example.com {\n\ttls cert.pem key.pem\n}\n\n' +
			'd.example.com {\n\ttls {\n\t\tdns cloudflare {env.CF}\n\t}\n}\n';
		const f = facts(text);
		expect(f.globalDns01).toEqual({ provider: 'porkbun' });
		expect(f.sites.map((s) => [s.certificate, s.dns01?.source ?? null, s.dns01?.provider ?? null])).toEqual([
			['acme', 'global', 'porkbun'],
			['internal', null, null],
			['files', null, null],
			['acme', 'site', 'cloudflare']
		]);
	});

	it('fills a bare dns or acme_dns line from the global dns option', () => {
		const text =
			'{\n\tdns porkbun {\n\t\tapi_key {env.A}\n\t\tapi_secret_key {env.B}\n\t}\n\tacme_dns\n}\n\na.example.com {\n\ttls {\n\t\tdns\n\t}\n}\n';
		expect(facts(text).globalDns01).toEqual({ provider: 'porkbun' });
		expect(site(text).dns01).toEqual({ source: 'site', provider: 'porkbun' });
		expect(site('a.example.com {\n\ttls {\n\t\tdns\n\t}\n}\n').dns01).toEqual({
			source: 'site',
			provider: null
		});
	});

	it('knows when no public certificate is wanted', () => {
		expect(site('{\n\tlocal_certs\n}\n\na.example.com {\n}\n').certificate).toBe('internal');
		expect(site('{\n\tauto_https off\n}\n\na.example.com {\n}\n').certificate).toBe('off');
		expect(site('{\n\tauto_https disable_redirects\n}\n\na.example.com {\n}\n').certificate).toBe('acme');
		expect(site('a.example.com {\n\ttls {\n\t\tissuer internal\n\t}\n}\n').certificate).toBe('internal');
		expect(site('a.example.com {\n\ttls {\n\t\ton_demand\n\t}\n}\n').onDemand).toBe(true);
	});

	it('ignores sites this UI commented out', () => {
		const text =
			'# caddy-ui:disabled lines=3\n# off.example.com {\n# \trespond "ok"\n# }\n\non.example.com {\n}\n';
		expect(facts(text).sites.map((s) => s.addresses[0])).toEqual(['on.example.com']);
	});
});
