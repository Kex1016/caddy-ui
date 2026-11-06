/**
 * Bespoke forms for the three global options David's Caddyfile uses (`email`, `admin`, `servers`); the
 * rest of the global options use the schema's generic forms.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
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

registerGlobalForm('email', emailForm);
registerGlobalForm('admin', adminForm);
registerGlobalForm('servers', serversForm);
