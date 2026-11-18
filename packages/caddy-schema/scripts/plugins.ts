/**
 * Plugin entries: things the Caddy docs do not describe because they come from a plugin, added on top of
 * the generated schema. Each entry names the Caddy module that must be compiled in (`plugin`), so the UI can
 * say when the running Caddy lacks it.
 *
 * So far this is the DNS providers used for the ACME DNS challenge. A provider is configured wherever Caddy
 * takes a `dns.providers.*` module, and those places are listed in `DNS_PROVIDER_HOSTS`. Providers this file
 * does not know stay valid: the host line takes any provider name and a free-form block.
 */
import type { DirectiveSchema, SchemaBundle } from '../src/types.ts';
import { resolve } from './overrides.ts';

export type DnsProviderPlugin = {
	/** The name after `dns` / `acme_dns`. */
	name: string;
	/** Caddy module ID. */
	module: string;
	docsUrl: string;
	summary: string;
	/** The provider's block options. Every one takes exactly one value. */
	options: { name: string; doc: string; required?: boolean; secret?: string }[];
};

/**
 * github.com/caddy-dns/porkbun, read at v0.3.1 (`UnmarshalCaddyfile`): no arguments on the `porkbun` line,
 * a block with `api_key` and `api_secret_key`, both required, one value each, anything else refused.
 */
export const PORKBUN: DnsProviderPlugin = {
	name: 'porkbun',
	module: 'dns.providers.porkbun',
	docsUrl: 'https://github.com/caddy-dns/porkbun',
	summary:
		'Solves the ACME DNS challenge at Porkbun. Needs a Caddy built with the `caddy-dns/porkbun` plugin.',
	options: [
		{
			name: 'api_key',
			doc: 'The Porkbun API key. Use `{env.PORKBUN_API_KEY}` so the key stays out of the Caddyfile.',
			required: true,
			secret: '{env.PORKBUN_API_KEY}'
		},
		{
			name: 'api_secret_key',
			doc: 'The Porkbun secret API key. Use `{env.PORKBUN_API_SECRET_KEY}` so the key stays out of the Caddyfile.',
			required: true,
			secret: '{env.PORKBUN_API_SECRET_KEY}'
		}
	]
};

export const DNS_PROVIDER_PLUGINS: readonly DnsProviderPlugin[] = [PORKBUN];

/** Where a DNS provider module is configured: `tls { dns … }`, the ACME issuer, and two global options. */
export const DNS_PROVIDER_HOSTS: readonly string[] = [
	'd:tls/dns',
	'd:tls/issuer/~acme/dns',
	'g:acme_dns',
	'g:dns'
];

function providerVariant(p: DnsProviderPlugin, host: DirectiveSchema): DirectiveSchema {
	const lines = p.options.map((o) => `\t${o.name} ${o.secret ?? `<${o.name}>`}`).join('\n');
	const required = p.options.filter((o) => o.required).map((o) => o.name);
	return {
		name: p.name,
		summary: p.summary,
		docsUrl: p.docsUrl,
		category: host.category,
		order: -1,
		matcher: false,
		args: [],
		subdirectives: Object.fromEntries(
			p.options.map((o): [string, DirectiveSchema] => [
				o.name,
				{
					name: o.name,
					summary: o.doc,
					docsUrl: p.docsUrl,
					category: host.category,
					order: -1,
					matcher: false,
					args: [{ name: o.name, type: 'string', doc: o.doc, ...(o.secret ? { secret: o.secret } : {}) }],
					examples: [],
					syntax: [`${o.name} <${o.name}>`],
					plugin: p.module
				}
			])
		),
		examples: [`${host.name} ${p.name} {\n${lines}\n}`],
		syntax: [`${host.name} ${p.name} {\n${p.options.map((o) => `\t${o.name} <${o.name}>`).join('\n')}\n}`],
		block: true,
		plugin: p.module,
		...(required.length ? { requires: required } : {})
	};
}

export function applyPlugins(b: SchemaBundle): void {
	for (const path of DNS_PROVIDER_HOSTS) {
		const host = resolve(b, path) as DirectiveSchema;
		// A provider's block is defined by its plugin, so one this file does not know must not be an error.
		host.block = true;
		host.freeformBody = true;
		host.variants = { ...(host.variants ?? {}) };
		for (const p of DNS_PROVIDER_PLUGINS) host.variants[p.name] = providerVariant(p, host);
	}
}
