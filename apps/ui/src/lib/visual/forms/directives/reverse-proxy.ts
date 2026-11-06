import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { claimsOf, note, rows, section, subList, variant } from '../fields';
import { argFields, bodyFields } from '../generic';
import { registerForm } from '../registry';
import type { FieldSpec, FormSpec } from '../types';
import { docsUrlOf, resolveSchema, schemaFields } from './schema-fields';
import { upstreamsField } from './upstreams';

const RP = ['reverse_proxy'] as const;

const HEADER_COLUMNS = [
	{ id: 'field', label: 'Header', type: 'header', prefixes: ['+', '-', '>'], placeholder: 'X-Real-IP' },
	{ id: 'value', label: 'Value', type: 'string', optional: true, placeholder: '{remote_host}' },
	{ id: 'replacement', label: 'Replace with', type: 'string', optional: true }
] as const;

/** `transport http { … }` / `transport fastcgi { … }` with the common TLS options first. */
function transportField(schema: SchemaBundle | null): FieldSpec {
	const http = resolveSchema(schema, [...RP, 'transport', 'http']);
	const fastcgi = resolveSchema(schema, [...RP, 'transport', 'fastcgi']);
	const httpFirst: FieldSpec[] = schemaFields(
		schema,
		[...RP, 'transport', 'http'],
		[
			[
				'tls',
				{ label: 'Use TLS to the backend', help: 'Needed when the upstream address has no https:// scheme.' }
			],
			[
				'tls_insecure_skip_verify',
				{
					label: 'Skip certificate verification',
					help: 'Accept any certificate from the backend. Only for backends you control.'
				}
			],
			[
				'tls_server_name',
				{ label: 'TLS server name', help: 'The name to verify the backend certificate against (SNI).' }
			],
			['tls_timeout', { label: 'TLS handshake timeout' }],
			['versions', { label: 'HTTP versions' }],
			['dial_timeout', { label: 'Dial timeout' }],
			['keepalive', { label: 'Keep-alive' }],
			['read_buffer', { label: 'Read buffer' }],
			['write_buffer', { label: 'Write buffer' }],
			['compression', { label: 'Compression to the backend' }],
			['proxy_protocol', { label: 'PROXY protocol' }]
		]
	);
	const shown = new Set(httpFirst.map((f) => f.id));
	const httpRest = http ? bodyFields(http).filter((f) => !shown.has(f.id)) : [];
	return variant('transport', {
		label: 'Transport',
		help: 'How Caddy talks to the backend. Leave unset for plain HTTP with Caddy’s defaults.',
		empty: 'Default (HTTP)',
		options: [
			{
				value: 'http',
				label: 'HTTP',
				fields: [...httpFirst, section('More HTTP transport options', httpRest, { collapsed: true })]
			},
			{
				value: 'fastcgi',
				label: 'FastCGI',
				fields: fastcgi ? [...argFields(fastcgi.args), ...bodyFields(fastcgi)] : []
			}
		]
	});
}

function lbPolicyField(schema: SchemaBundle | null): FieldSpec {
	const lb = resolveSchema(schema, [...RP, 'lb_policy']);
	const options = Object.entries(lb?.variants ?? {}).map(([value, v]) => ({
		value,
		label: value.replace(/_/g, ' '),
		doc: v.summary,
		fields: [...argFields(v.args), ...bodyFields(v)]
	}));
	if (!options.length) {
		for (const value of ['round_robin', 'random', 'least_conn', 'ip_hash', 'first', 'cookie'])
			options.push({ value, label: value.replace(/_/g, ' '), doc: '', fields: [] });
	}
	return variant('lb_policy', {
		label: 'Policy',
		help: 'How requests are spread over several upstreams. Default: random.',
		empty: 'Default (random)',
		options
	});
}

export function reverseProxyForm(schema: SchemaBundle | null): FormSpec {
	const fields: FieldSpec[] = [
		upstreamsField(),
		section('Headers', [
			rows('header_up', {
				label: 'Request headers to the backend',
				help: 'Set, add (+), remove (-) or rewrite a header on the request before it goes upstream.',
				columns: HEADER_COLUMNS,
				addLabel: 'Add request header'
			}),
			rows('header_down', {
				label: 'Response headers to the client',
				columns: HEADER_COLUMNS,
				addLabel: 'Add response header'
			}),
			...schemaFields(schema, RP, [
				['method', { label: 'Change the request method' }],
				['rewrite', { label: 'Rewrite the request URI' }],
				['proxy_status_name', { label: 'Proxy-Status name' }]
			]),
			subList('trusted_proxies', {
				label: 'Trusted proxies',
				help: 'Proxies whose X-Forwarded-* headers are trusted; private_ranges covers all private networks.',
				type: 'string',
				literals: ['private_ranges']
			})
		]),
		section('Transport', [transportField(schema)]),
		section(
			'Load balancing',
			[
				lbPolicyField(schema),
				...schemaFields(schema, RP, [
					['lb_retries', { label: 'Retries' }],
					['lb_try_duration', { label: 'Try for' }],
					['lb_try_interval', { label: 'Try interval' }],
					['lb_retry_match', { label: 'Retry only requests matching' }]
				])
			],
			{ collapsed: true }
		),
		section(
			'Active health checks',
			[
				...schemaFields(schema, RP, [
					[
						'health_uri',
						{ label: 'Check URI', help: 'Caddy requests this path on each upstream on an interval.' }
					],
					['health_interval', { label: 'Interval' }],
					['health_timeout', { label: 'Timeout' }],
					['health_status', { label: 'Expected status' }],
					['health_port', { label: 'Port' }],
					['health_upstream', { label: 'Check a different upstream' }],
					['health_method', { label: 'Method' }],
					['health_passes', { label: 'Passes before healthy' }],
					['health_fails', { label: 'Fails before unhealthy' }],
					['health_body', { label: 'Expected body (regexp)' }],
					['health_request_body', { label: 'Request body' }],
					['health_follow_redirects', { label: 'Follow redirects' }],
					['health_headers', { label: 'Request headers' }]
				])
			],
			{ collapsed: true, help: 'Off unless a check URI is set.' }
		),
		section(
			'Passive health checks',
			schemaFields(schema, RP, [
				[
					'fail_duration',
					{
						label: 'Remember a failure for',
						help: 'How long a failed request counts against the upstream. Off when unset.'
					}
				],
				['max_fails', { label: 'Max fails' }],
				['unhealthy_status', { label: 'Unhealthy status codes' }],
				['unhealthy_latency', { label: 'Unhealthy latency' }],
				['unhealthy_request_count', { label: 'Unhealthy request count' }]
			]),
			{ collapsed: true }
		),
		section(
			'Streaming and buffers',
			schemaFields(schema, RP, [
				[
					'flush_interval',
					{
						label: 'Flush interval',
						help: '-1 streams every byte immediately (server-sent events, long polling).'
					}
				],
				['request_buffers', { label: 'Request buffer' }],
				['response_buffers', { label: 'Response buffer' }],
				['stream_timeout', { label: 'Stream timeout' }],
				['stream_close_delay', { label: 'Stream close delay' }]
			]),
			{ collapsed: true }
		),
		section(
			'Dynamic upstreams',
			[...schemaFields(schema, RP, [['dynamic', { label: 'Discover upstreams with' }]])],
			{ collapsed: true, help: 'Look upstreams up by DNS (A or SRV) instead of listing them.' }
		),
		section(
			'Responses',
			[
				...schemaFields(schema, RP, [['replace_status', { label: 'Replace status' }]]),
				note(
					'Response matchers (@name { status … }) and handle_response blocks appear as children of this directive in the tree; select one there to edit it.'
				)
			],
			{ collapsed: true }
		)
	];
	return {
		name: 'reverse_proxy',
		title: 'Reverse proxy',
		summary: 'Send requests to one or more backends.',
		docsUrl: docsUrlOf(schema, 'reverse_proxy'),
		fields,
		claims: [...claimsOf(fields), 'to', 'handle_response', 'header_up', 'header_down']
	};
}

/** The same knobs for `forward_auth`, which is `reverse_proxy` with presets. */
export function proxyTuningSections(schema: SchemaBundle | null): FieldSpec[] {
	const full = reverseProxyForm(schema);
	return full.fields.filter((f) => f.kind === 'section' && f.id !== 'section:headers');
}

registerForm('reverse_proxy', reverseProxyForm);
