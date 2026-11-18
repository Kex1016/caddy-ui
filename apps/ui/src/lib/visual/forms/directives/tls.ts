/**
 * TLS and ACME: `tls` and `acme_server`.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import type { Directive } from '@caddy-ui/caddyfile';
import { claimsOf, flag, group, section, subList, subSelect, subText, variant } from '../fields';
import { argFields, bodyFields } from '../generic';
import { getArg, replaceArgs, subs } from '../node';
import { registerForm } from '../registry';
import type { CustomField, FieldSpec, FormSpec, SelectField, TextField } from '../types';
import DnsProviderField from '../DnsProviderField.svelte';
import { subArg, subArgSelect } from './helpers';
import { docsUrlOf, resolveSchema, schemaFields } from './schema-fields';

type Mode = 'auto' | 'email' | 'internal' | 'files' | 'force_automate';

/** What the `tls` line's arguments say about where the certificate comes from. */
export function tlsMode(n: Directive): Mode {
	const [a, b] = n.args.map((t) => t.text);
	if (a === undefined) return 'auto';
	if (a === 'internal') return 'internal';
	if (a === 'force_automate') return 'force_automate';
	if (b !== undefined) return 'files';
	return a === '' || a.includes('@') || a.startsWith('{') ? 'email' : 'files';
}

const MODES = [
	{
		value: 'auto',
		label: 'Automatic (Let’s Encrypt / ZeroSSL)',
		doc: 'Caddy gets and renews a public certificate.'
	},
	{ value: 'email', label: 'Automatic, with an ACME account email' },
	{
		value: 'internal',
		label: 'Caddy’s own local CA',
		doc: 'Self-signed; for internal names that public CAs cannot validate.'
	},
	{ value: 'files', label: 'Certificate and key files' },
	{ value: 'force_automate', label: 'Automate even if a loaded certificate covers the name' }
];

export function tlsForm(schema: SchemaBundle | null): FormSpec {
	const TLS = ['tls'];
	const mode: SelectField = {
		kind: 'select',
		id: 'mode',
		label: 'Certificate',
		options: MODES,
		help: 'Where the certificate for this site comes from.',
		get: tlsMode,
		set: (n, v) => {
			const cur = tlsMode(n);
			if (v === cur) return;
			switch (v as Mode | undefined) {
				case 'email':
					replaceArgs(n, [cur === 'email' ? getArg(n, 0)! : '']);
					break;
				case 'internal':
				case 'force_automate':
					replaceArgs(n, [v!]);
					break;
				case 'files':
					replaceArgs(n, ['cert.pem', 'key.pem']);
					break;
				default:
					replaceArgs(n, []);
			}
		}
	};
	const email: TextField = {
		kind: 'text',
		id: 'email',
		label: 'Email',
		type: 'string',
		placeholder: 'you@example.com',
		help: 'The CA may email about problems with the certificate. The global email option sets it for every site.',
		when: (n) => tlsMode(n) === 'email',
		get: (n) => getArg(n, 0),
		set: (n, v) => replaceArgs(n, [v ?? ''])
	};
	const cert: TextField = {
		kind: 'text',
		id: 'cert',
		label: 'Certificate file',
		type: 'path',
		required: true,
		placeholder: '/etc/caddy/certs/example.com.pem',
		help: 'PEM, with the full chain. A path inside the Caddy container.',
		when: (n) => tlsMode(n) === 'files',
		get: (n) => getArg(n, 0),
		set: (n, v) => replaceArgs(n, [v ?? '', getArg(n, 1) ?? ''])
	};
	const key: TextField = {
		kind: 'text',
		id: 'key',
		label: 'Key file',
		type: 'path',
		required: true,
		placeholder: '/etc/caddy/certs/example.com.key',
		when: (n) => tlsMode(n) === 'files',
		get: (n) => getArg(n, 1),
		set: (n, v) => replaceArgs(n, v ? [getArg(n, 0) ?? '', v] : n.args.slice(0, 1).map((a) => a.text))
	};

	// Porkbun is guided, any other provider is free text (docs/porkbun-plan.md §4). Edits the `dns` line.
	const dnsProvider: CustomField = {
		kind: 'custom',
		id: 'dns',
		label: 'DNS provider',
		component: DnsProviderField
	};

	const issuerSchema = resolveSchema(schema, [...TLS, 'issuer']);
	const issuer = variant('issuer', {
		label: 'Issuer',
		help: 'Which CA issues the certificate. Several issuer lines are tried in order; this edits the first.',
		empty: 'Default (Let’s Encrypt, then ZeroSSL)',
		options: [
			['acme', 'An ACME CA'],
			['zerossl', 'ZeroSSL with an API key'],
			['internal', 'Caddy’s local CA']
		].map(([value, label]) => {
			const v = issuerSchema?.variants?.[value!];
			return {
				value: value!,
				label: label!,
				doc: v?.summary,
				fields: v ? [...argFields(v.args).map(shiftArg), ...bodyFields(v)] : []
			};
		})
	});

	const getCertSchema = resolveSchema(schema, [...TLS, 'get_certificate']);
	const getCertificate = variant('get_certificate', {
		label: 'Get certificates from',
		help: 'A certificate manager asked during the handshake, such as Tailscale.',
		empty: 'Not set',
		options: [
			['http', 'An HTTP endpoint'],
			['tailscale', 'Tailscale']
		].map(([value, label]) => {
			const v = getCertSchema?.variants?.[value!];
			return { value: value!, label: label!, fields: v ? argFields(v.args).map(shiftArg) : [] };
		})
	});

	const clientAuthSchema = resolveSchema(schema, [...TLS, 'client_auth']);
	const trustPoolSchema = clientAuthSchema?.subdirectives?.['trust_pool'];
	const clientAuth = group('client_auth', {
		label: 'Client certificates (mTLS)',
		help: 'Ask clients for a certificate and check it.',
		collapsed: true,
		fields: [
			subSelect('mode', {
				label: 'Mode',
				options: [
					{ value: 'request', label: 'Request a certificate' },
					{ value: 'require', label: 'Require one' },
					{ value: 'verify_if_given', label: 'Verify one if given' },
					{ value: 'require_and_verify', label: 'Require and verify (default with a trust pool)' }
				]
			}),
			variant('trust_pool', {
				label: 'Trust certificates from',
				empty: 'Not set',
				options: Object.entries(trustPoolSchema?.variants ?? {}).map(([value, v]) => ({
					value,
					label: value.replace(/_/g, ' '),
					doc: v.summary,
					fields: [...argFields(v.args).map(shiftArg), ...bodyFields(v)]
				}))
			}),
			subText('verifier', { label: 'Verifier module' })
		]
	});

	const fields: FieldSpec[] = [
		mode,
		email,
		cert,
		key,
		section(
			'DNS challenge',
			[
				dnsProvider,
				...schemaFields(schema, TLS, [
					['resolvers', { label: 'DNS resolvers', help: 'Used to check that the record propagated.' }],
					['propagation_delay', { label: 'Wait before checking' }],
					['propagation_timeout', { label: 'Give up after' }],
					['dns_ttl', { label: 'Record TTL' }],
					['dns_challenge_override_domain', { label: 'Delegate the challenge to' }]
				])
			],
			{ help: 'For wildcard certificates or sites not reachable from the internet.' }
		),
		section(
			'Issuer and ACME',
			[
				issuer,
				...schemaFields(schema, TLS, [
					['ca', { label: 'ACME directory URL', help: 'Shortcut for issuer acme <url>.' }],
					['ca_root', { label: 'CA root certificate' }]
				]),
				subArg('eab', 0, { label: 'EAB key ID', placeholders: false }),
				subArg('eab', 1, { label: 'EAB MAC key', placeholder: '{env.EAB_MAC_KEY}' }),
				flag('on_demand', {
					label: 'Get certificates on demand',
					help: 'At the first handshake for a name. Needs the global on_demand_tls ask endpoint.'
				}),
				...schemaFields(schema, TLS, [
					['renewal_window_ratio', { label: 'Renew when this much lifetime is left', help: 'Such as 0.33.' }],
					['reuse_private_keys', { label: 'Reuse the private key on renewal' }]
				])
			],
			{ collapsed: true }
		),
		section(
			'Protocols and keys',
			[
				subArgSelect('protocols', 0, {
					label: 'Oldest TLS version',
					options: [
						{ value: 'tls1.2', label: 'TLS 1.2 (default)' },
						{ value: 'tls1.3', label: 'TLS 1.3' }
					]
				}),
				subArgSelect('protocols', 1, {
					label: 'Newest TLS version',
					options: [
						{ value: 'tls1.2', label: 'TLS 1.2' },
						{ value: 'tls1.3', label: 'TLS 1.3 (default)' }
					],
					when: (n) => subs(n, 'protocols').length > 0
				}),
				subSelect('key_type', {
					label: 'Key type',
					options: ['ed25519', 'p256', 'p384', 'rsa2048', 'rsa4096'].map((v) => ({ value: v, label: v })),
					empty: 'Default (p256)'
				}),
				...schemaFields(schema, TLS, [
					['ciphers', { label: 'Cipher suites', help: 'TLS 1.2 only; Go’s defaults are good.' }],
					['curves', { label: 'Key exchange groups' }],
					['alpn', { label: 'ALPN protocols' }]
				])
			],
			{ collapsed: true }
		),
		section('Client authentication', [clientAuth], { collapsed: true }),
		section(
			'More',
			[
				getCertificate,
				subList('load', {
					label: 'Load certificates from folders',
					type: 'path',
					placeholder: '/etc/caddy/certs'
				}),
				subText('insecure_secrets_log', {
					label: 'Write TLS secrets to',
					type: 'path',
					help: 'For decrypting traffic in Wireshark. Never leave this on.'
				})
			],
			{ collapsed: true }
		)
	];
	return {
		name: 'tls',
		title: 'TLS',
		summary: 'How this site gets its certificate and which TLS settings it uses.',
		docsUrl: docsUrlOf(schema, 'tls'),
		fields,
		claims: [...claimsOf(fields), 'dns', 'eab', 'protocols'],
		describe: (n) => MODES.find((m) => m.value === tlsMode(n))?.label.split(' (')[0] ?? ''
	};
}

/**
 * A module's own arguments sit after the module name on its line (`issuer acme <url>`), so the
 * schema's argument N is the line's argument N+1.
 */
function shiftArg(f: FieldSpec): FieldSpec {
	if ((f.kind !== 'text' && f.kind !== 'select' && f.kind !== 'list') || !/^args?\d+$/.test(f.id)) return f;
	const i = Number(f.id.replace(/\D/g, ''));
	if (f.kind === 'list')
		return {
			...f,
			id: `args${i + 1}`,
			get: (n) => n.args.slice(i + 1).map((a) => a.text),
			set: (n: Directive, v: string[]) => replaceArgs(n, [...n.args.slice(0, i + 1).map((a) => a.text), ...v])
		};
	return {
		...f,
		id: `arg${i + 1}`,
		get: (n: Directive) => getArg(n, i + 1),
		set: (n: Directive, v: string | undefined) => {
			const args = n.args.map((a) => a.text);
			if (!v) args.splice(i + 1);
			else {
				while (args.length < i + 1) args.push('');
				args[i + 1] = v;
			}
			replaceArgs(n, args);
		}
	} as FieldSpec;
}

export function acmeServerForm(schema: SchemaBundle | null): FormSpec {
	const AS = ['acme_server'];
	const listGroup = (name: 'allow' | 'deny', label: string) =>
		group(name, {
			label,
			collapsed: true,
			fields: [
				subList('domains', { label: 'Domains', placeholder: '*.home.arpa' }),
				subList('ip_ranges', { label: 'IP ranges', placeholder: '10.0.0.0/8' })
			]
		});
	const fields: FieldSpec[] = [
		subText('ca', {
			label: 'CA',
			placeholder: 'local',
			placeholders: false,
			help: 'The id of a CA from the global pki option. Default: local.'
		}),
		subText('lifetime', {
			label: 'Certificate lifetime',
			type: 'duration',
			placeholder: '12h',
			help: 'Default 12h.'
		}),
		subList('challenges', {
			label: 'Challenges',
			choices: [
				{ value: 'http-01', label: 'HTTP-01' },
				{ value: 'tls-alpn-01', label: 'TLS-ALPN-01' },
				{ value: 'dns-01', label: 'DNS-01' }
			],
			help: 'None ticked allows all three.'
		}),
		section(
			'Who may get certificates',
			[
				flag('allow_wildcard_names', { label: 'Allow wildcard names' }),
				listGroup('allow', 'Allow only'),
				listGroup('deny', 'Deny')
			],
			{ collapsed: true }
		),
		...schemaFields(schema, AS, [
			['resolvers', { label: 'DNS resolvers', help: 'For validating challenges.' }]
		])
	];
	return {
		name: 'acme_server',
		title: 'ACME server',
		summary: 'Run an ACME CA on this site so other machines can get certificates from Caddy’s CA.',
		docsUrl: docsUrlOf(schema, 'acme_server'),
		fields,
		claims: claimsOf(fields)
	};
}

registerForm('tls', tlsForm);
registerForm('acme_server', acmeServerForm);
