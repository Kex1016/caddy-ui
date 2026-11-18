/**
 * Bespoke forms for the three global options David's Caddyfile uses (`email`, `admin`, `servers`) and the
 * two that name a DNS provider (`acme_dns`, `dns`); the rest of the global options use the schema's generic
 * forms.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import DnsProviderField from './DnsProviderField.svelte';
import { dnsClaims } from './directives/dns-provider';
import { arg, argList, claimsOf, note, rows, section } from './fields';
import { registerGlobalForm } from './registry';
import type { FieldSpec, FormSpec } from './types';
import { schemaFields } from './directives/schema-fields';

const docs = (schema: SchemaBundle | null, name: string) =>
	schema?.globalOptions[name]?.docsUrl ??
	`https://caddyserver.com/docs/caddyfile/options#${name.replace(/_/g, '-')}`;

export function emailForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'email',
		title: 'ACME email',
		summary: 'The address Let’s Encrypt or ZeroSSL can reach you at about certificates.',
		docsUrl: docs(schema, 'email'),
		fields: [
			arg(0, {
				label: 'Email address',
				type: 'string',
				required: true,
				placeholder: 'admin@example.com',
				placeholders: false
			})
		],
		claims: []
	};
}

export function adminForm(schema: SchemaBundle | null): FormSpec {
	const fields: FieldSpec[] = [
		arg(0, {
			label: 'Admin API address',
			type: 'string',
			required: true,
			placeholder: '0.0.0.0:2019',
			literals: ['off'],
			help: 'This UI talks to Caddy here. 0.0.0.0:2019 answers on every interface inside the container; off disables the API (and this UI).',
			placeholders: false
		}),
		...schemaFields(
			schema,
			['admin'],
			[
				['origins', { label: 'Allowed origins' }],
				['enforce_origin', { label: 'Enforce the Origin header' }]
			],
			'globalOptions'
		),
		note('Setting admin off stops this UI from applying changes.', {
			tone: 'warning',
			when: (n) => n.args[0]?.text === 'off'
		})
	];
	return {
		name: 'admin',
		title: 'Admin API',
		summary: 'Where Caddy’s admin API listens.',
		docsUrl: docs(schema, 'admin'),
		fields,
		claims: claimsOf(fields)
	};
}

export function serversForm(schema: SchemaBundle | null): FormSpec {
	const fields: FieldSpec[] = [
		argList(0, {
			label: 'Only for listener',
			type: 'string',
			placeholder: ':443',
			help: 'Leave empty to apply to every server; or a listener address such as :443.'
		}),
		rows('trusted_proxies', {
			label: 'Trusted proxies',
			help: 'Proxies in front of Caddy whose X-Forwarded-For is believed: static with IPs or ranges (private_ranges for every private network).',
			columns: [
				{
					id: 'module',
					label: 'Source',
					type: 'string',
					options: [{ value: 'static', label: 'static' }],
					placeholder: 'static'
				},
				{ id: 'ranges', label: 'IPs or ranges', type: 'string', placeholder: '10.0.0.103' }
			],
			addLabel: 'Add trusted proxy'
		}),
		section(
			'More server options',
			schemaFields(
				schema,
				['servers'],
				[
					['client_ip_headers', { label: 'Client IP headers' }],
					['trusted_proxies_strict', { label: 'Strict trusted proxies' }],
					['protocols', { label: 'Protocols' }],
					['timeouts', { label: 'Timeouts' }],
					['max_header_size', { label: 'Max header size' }],
					['log_credentials', { label: 'Log credentials' }],
					['strict_sni_host', { label: 'Strict SNI host' }],
					['metrics', { label: 'Metrics' }]
				],
				'globalOptions'
			),
			{ collapsed: true }
		)
	];
	return {
		name: 'servers',
		title: 'Servers',
		summary: 'Options for the HTTP servers Caddy runs: trusted proxies, timeouts, protocols.',
		docsUrl: docs(schema, 'servers'),
		fields,
		claims: claimsOf(fields)
	};
}

/**
 * `acme_dns` and the global `dns` option: the same provider picker as the `tls` form (Porkbun guided, any
 * other provider as free text). The option is the provider line itself.
 */
function dnsProviderForm(name: 'acme_dns' | 'dns', title: string, summary: string) {
	return (schema: SchemaBundle | null): FormSpec => ({
		name,
		title,
		summary,
		docsUrl: docs(schema, name),
		fields: [{ kind: 'custom', id: 'provider', label: 'DNS provider', component: DnsProviderField }],
		claims: [],
		claimsFor: dnsClaims,
		describe: (n) => n.args[0]?.text ?? 'default provider'
	});
}

export const acmeDnsForm = dnsProviderForm(
	'acme_dns',
	'ACME DNS challenge',
	'Every site gets its certificate through the DNS challenge with this provider. Needed for wildcard certificates.'
);

export const globalDnsForm = dnsProviderForm(
	'dns',
	'Default DNS provider',
	'The DNS provider used wherever a site or option asks for one without naming it (Caddy 2.10 and later).'
);

registerGlobalForm('email', emailForm);
registerGlobalForm('admin', adminForm);
registerGlobalForm('servers', serversForm);
registerGlobalForm('acme_dns', acmeDnsForm);
registerGlobalForm('dns', globalDnsForm);
