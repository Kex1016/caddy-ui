import { DNS_RECORD_TYPES, type DnsRecordType } from '$lib/api/porkbun';
import {
	cleanHex,
	fqdn,
	hasControlChar,
	isHex,
	isIPv4,
	isIPv6,
	normaliseTarget,
	targetProblem,
	wholeNumber
} from './names';

/**
 * The 14 record types this build edits, one definition each: the fields its form shows, how a stored value
 * splits into those fields and joins back, and what makes a value wrong.
 *
 * Porkbun stores a record as one `content` string plus, for MX and SRV, a separate priority. A form with one
 * free-text box per record would leave the format to memory, so each type names its parts. `split` returns
 * null for a stored value that does not have the expected shape; the form then shows the value as one field
 * instead of guessing, and nothing is lost.
 */

export type Parts = Record<string, string>;

export type FieldDef = {
	key: string;
	label: string;
	/** `long` is a multi-line box for values that wrap (TXT, keys, fingerprints). */
	kind: 'text' | 'number' | 'select' | 'long';
	hint?: string;
	placeholder?: string;
	options?: readonly { value: string; label: string }[];
	min?: number;
	max?: number;
};

export type PartError = { part: string; message: string };

export type KindContext = { host: string; domain: string };

export type RecordKind = {
	type: DnsRecordType;
	/** What the type is for, in a few words: shown next to the type in the picker. */
	title: string;
	/** One sentence under the picker. */
	summary: string;
	/** Whether Porkbun keeps a separate priority for the type. */
	usesPrio: boolean;
	/** How the name is usually written for this type. */
	hostHint?: string;
	fields: readonly FieldDef[];
	defaults: Parts;
	/** The stored value as form fields, or null when it does not have the expected shape. */
	split(content: string, prio: number | null): Parts | null;
	/** Form fields as the value to store. Only meaningful after `check` found nothing. */
	join(parts: Parts): { content: string; prio?: number };
	check(parts: Parts, ctx: KindContext): PartError[];
	/** Things worth saying that do not stop the change. */
	advise?(parts: Parts, ctx: KindContext): string[];
};

const U16 = 65535;
const prioField: FieldDef = {
	key: 'prio',
	label: 'Priority',
	kind: 'number',
	min: 0,
	max: U16,
	hint: 'Lower is tried first.'
};

const need = (parts: Parts, key: string): string => (parts[key] ?? '').trim();

function numberError(parts: Parts, key: string, label: string, min: number, max: number): PartError[] {
	return wholeNumber(need(parts, key), min, max) === null
		? [{ part: key, message: `${label} must be a whole number from ${min} to ${max}` }]
		: [];
}

function targetError(parts: Parts, key: string, opts: { allowRoot?: boolean } = {}): PartError[] {
	const problem = targetProblem(normaliseTarget(need(parts, key)), opts);
	return problem ? [{ part: key, message: problem }] : [];
}

function hexError(parts: Parts, key: string, label: string, lengths: Record<string, number>, by: string) {
	const hex = cleanHex(need(parts, key));
	if (!isHex(hex)) {
		return [{ part: key, message: `${label} must be hexadecimal: the digits 0-9 and letters a-f, in pairs` }];
	}
	const want = lengths[need(parts, by)];
	if (want !== undefined && hex.length !== want) {
		return [
			{
				part: key,
				message: `${label} must be ${want} hexadecimal characters for this type, not ${hex.length}`
			}
		];
	}
	return [];
}

/** A kind whose whole value is one hostname. */
function pointer(
	type: DnsRecordType,
	title: string,
	summary: string,
	label: string,
	extra: Partial<RecordKind> = {}
): RecordKind {
	return {
		type,
		title,
		summary,
		usesPrio: false,
		fields: [{ key: 'target', label, kind: 'text', placeholder: 'host.example.net' }],
		defaults: { target: '' },
		split: (content) => ({ target: content.trim() }),
		join: (parts) => ({ content: normaliseTarget(need(parts, 'target')) }),
		check: (parts) => targetError(parts, 'target'),
		...extra
	};
}

const A: RecordKind = {
	type: 'A',
	title: 'IPv4 address',
	summary: 'Points a name at an IPv4 address.',
	usesPrio: false,
	fields: [{ key: 'address', label: 'IPv4 address', kind: 'text', placeholder: '203.0.113.10' }],
	defaults: { address: '' },
	split: (content) => ({ address: content.trim() }),
	join: (parts) => ({ content: need(parts, 'address') }),
	check(parts) {
		const address = need(parts, 'address');
		if (isIPv4(address)) return [];
		return [
			{
				part: 'address',
				message: isIPv6(address)
					? 'That is an IPv6 address: use an AAAA record for it'
					: 'Enter an IPv4 address such as 203.0.113.10'
			}
		];
	}
};

const AAAA: RecordKind = {
	type: 'AAAA',
	title: 'IPv6 address',
	summary: 'Points a name at an IPv6 address.',
	usesPrio: false,
	fields: [{ key: 'address', label: 'IPv6 address', kind: 'text', placeholder: '2001:db8::10' }],
	defaults: { address: '' },
	split: (content) => ({ address: content.trim() }),
	join: (parts) => ({ content: need(parts, 'address').toLowerCase() }),
	check(parts) {
		const address = need(parts, 'address');
		if (isIPv6(address)) return [];
		return [
			{
				part: 'address',
				message: isIPv4(address)
					? 'That is an IPv4 address: use an A record for it'
					: 'Enter an IPv6 address such as 2001:db8::10'
			}
		];
	}
};

const CNAME: RecordKind = pointer(
	'CNAME',
	'Alias of another name',
	'Makes a name an alias of another hostname. It must be the only record at its name.',
	'Points to',
	{
		check(parts, ctx) {
			const errors = targetError(parts, 'target');
			if (errors.length > 0) return errors;
			return normaliseTarget(need(parts, 'target')) === fqdn(ctx.host, ctx.domain)
				? [{ part: 'target', message: 'A CNAME can not point at its own name' }]
				: [];
		},
		advise: (_parts, ctx) =>
			ctx.host === ''
				? [
						'A CNAME at the bare domain is not standard DNS, because the bare domain always has other records. Porkbun offers the ALIAS type for this.'
					]
				: []
	}
);

const ALIAS: RecordKind = pointer(
	'ALIAS',
	'Alias that can share its name',
	'Like a CNAME, but allowed at the bare domain and next to other records. Porkbun resolves it to addresses for you.',
	'Points to'
);

const NS: RecordKind = pointer(
	'NS',
	'Delegate a subdomain',
	'Hands a subdomain to other nameservers. The nameservers of the domain itself are on the Registry tab.',
	'Nameserver',
	{
		hostHint: 'The subdomain to delegate, for example lab.',
		advise: (_parts, ctx) =>
			ctx.host === ''
				? ["A record here does not change the domain's own nameservers. Those are set on the Registry tab."]
				: []
	}
);

const MX: RecordKind = {
	type: 'MX',
	title: 'Mail server',
	summary: 'Names a server that accepts mail for this name.',
	usesPrio: true,
	fields: [prioField, { key: 'server', label: 'Mail server', kind: 'text', placeholder: 'mail.example.com' }],
	defaults: { prio: '10', server: '' },
	split: (content, prio) => ({ prio: String(prio ?? 0), server: content.trim() }),
	join: (parts) => ({
		content: normaliseTarget(need(parts, 'server')),
		prio: wholeNumber(need(parts, 'prio'), 0, U16) ?? 0
	}),
	check: (parts) => [...numberError(parts, 'prio', 'Priority', 0, U16), ...targetError(parts, 'server')]
};

const TXT_MAX = 8192;

const TXT: RecordKind = {
	type: 'TXT',
	title: 'Text',
	summary: 'Holds free text: SPF, DKIM and DMARC policies, and ownership checks of other services.',
	usesPrio: false,
	hostHint: 'For example _dmarc, or a selector such as key1._domainkey.',
	fields: [
		{
			key: 'text',
			label: 'Text',
			kind: 'long',
			placeholder: 'v=spf1 mx -all',
			hint: 'Without the surrounding quotes. Long values are split for DNS by Porkbun.'
		}
	],
	defaults: { text: '' },
	split: (content) => ({ text: content }),
	join: (parts) => ({ content: need(parts, 'text') }),
	check(parts) {
		const text = need(parts, 'text');
		if (text === '') return [{ part: 'text', message: 'Enter the text' }];
		if (hasControlChar(text)) {
			return [{ part: 'text', message: 'The text must be on one line: remove the line breaks and tabs' }];
		}
		if (text.length > TXT_MAX) {
			return [{ part: 'text', message: `The text is longer than ${TXT_MAX} characters` }];
		}
		return [];
	},
	advise(parts) {
		const text = need(parts, 'text');
		return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
			? [
					'The text starts and ends with a quote. Porkbun adds the quotes DNS needs by itself, so they are usually left out.'
				]
			: [];
	}
};

const SRV: RecordKind = {
	type: 'SRV',
	title: 'Service location',
	summary: 'Says which host and port provide a service.',
	usesPrio: true,
	hostHint: 'The service and protocol, for example _sip._tcp.',
	fields: [
		prioField,
		{
			key: 'weight',
			label: 'Weight',
			kind: 'number',
			min: 0,
			max: U16,
			hint: 'Share among equal priorities.'
		},
		{ key: 'port', label: 'Port', kind: 'number', min: 0, max: U16 },
		{ key: 'target', label: 'Target host', kind: 'text', placeholder: 'sip.example.com' }
	],
	defaults: { prio: '0', weight: '0', port: '', target: '' },
	split(content, prio) {
		const m = /^(\d+)\s+(\d+)\s+(\S+)$/.exec(content.trim());
		if (!m) return null;
		return { prio: String(prio ?? 0), weight: m[1] as string, port: m[2] as string, target: m[3] as string };
	},
	join: (parts) => ({
		content: `${need(parts, 'weight')} ${need(parts, 'port')} ${normaliseTarget(need(parts, 'target'))}`,
		prio: wholeNumber(need(parts, 'prio'), 0, U16) ?? 0
	}),
	check: (parts) => [
		...numberError(parts, 'prio', 'Priority', 0, U16),
		...numberError(parts, 'weight', 'Weight', 0, U16),
		...numberError(parts, 'port', 'Port', 0, U16),
		...targetError(parts, 'target', { allowRoot: true })
	],
	advise: (_parts, ctx) =>
		/^_[a-z0-9-]+\._[a-z0-9-]+(\.|$)/.test(ctx.host)
			? []
			: ['An SRV name normally starts with the service and the protocol, for example _sip._tcp.']
};

const CAA_TAGS = [
	{ value: 'issue', label: 'issue: may issue certificates' },
	{ value: 'issuewild', label: 'issuewild: may issue wildcard certificates' },
	{ value: 'iodef', label: 'iodef: where to report violations' },
	{ value: 'issuemail', label: 'issuemail: may issue mail certificates' },
	{ value: 'issuevmc', label: 'issuevmc: may issue mark certificates' }
] as const;

const CAA: RecordKind = {
	type: 'CAA',
	title: 'Certificate authority',
	summary: 'Says which certificate authorities may issue certificates for this name.',
	usesPrio: false,
	fields: [
		{
			key: 'flags',
			label: 'Flags',
			kind: 'select',
			options: [
				{ value: '0', label: '0: normal' },
				{ value: '128', label: '128: critical' }
			]
		},
		{ key: 'tag', label: 'Tag', kind: 'select', options: CAA_TAGS },
		{
			key: 'value',
			label: 'Value',
			kind: 'text',
			placeholder: 'letsencrypt.org',
			hint: 'The authority\'s domain, a mailto: or https: address for iodef, or ";" to allow none.'
		}
	],
	defaults: { flags: '0', tag: 'issue', value: '' },
	split(content) {
		const m = /^(\d+)\s+([A-Za-z0-9]+)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))$/.exec(content.trim());
		if (!m) return null;
		const value = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : (m[4] as string);
		return { flags: m[1] as string, tag: (m[2] as string).toLowerCase(), value };
	},
	join: (parts) => ({
		content: `${need(parts, 'flags')} ${need(parts, 'tag').toLowerCase()} "${need(parts, 'value').replace(/(["\\])/g, '\\$1')}"`
	}),
	check(parts) {
		const errors = numberError(parts, 'flags', 'Flags', 0, 255);
		if (!/^[A-Za-z0-9]{1,15}$/.test(need(parts, 'tag'))) {
			errors.push({ part: 'tag', message: 'The tag is one word of letters and digits, for example issue' });
		}
		const value = need(parts, 'value');
		if (value === '') {
			errors.push({ part: 'value', message: 'Enter a value. Use ";" to allow no authority at all' });
		} else if (hasControlChar(value)) {
			errors.push({ part: 'value', message: 'The value must be on one line' });
		}
		return errors;
	}
};

const TLSA: RecordKind = {
	type: 'TLSA',
	title: 'Certificate pin (DANE)',
	summary: 'Pins the certificate or key a TLS service must present. Only honoured in a DNSSEC-signed zone.',
	usesPrio: false,
	hostHint: 'The port and protocol, for example _443._tcp or _25._tcp.mail.',
	fields: [
		{
			key: 'usage',
			label: 'Usage',
			kind: 'select',
			options: [
				{ value: '0', label: '0: CA constraint (PKIX-TA)' },
				{ value: '1', label: '1: service certificate (PKIX-EE)' },
				{ value: '2', label: '2: trust anchor (DANE-TA)' },
				{ value: '3', label: '3: domain-issued certificate (DANE-EE)' }
			]
		},
		{
			key: 'selector',
			label: 'Selector',
			kind: 'select',
			options: [
				{ value: '0', label: '0: whole certificate' },
				{ value: '1', label: '1: public key only' }
			]
		},
		{
			key: 'matching',
			label: 'Matching type',
			kind: 'select',
			options: [
				{ value: '0', label: '0: exact data' },
				{ value: '1', label: '1: SHA-256' },
				{ value: '2', label: '2: SHA-512' }
			]
		},
		{ key: 'data', label: 'Certificate data', kind: 'long', hint: 'Hexadecimal.' }
	],
	defaults: { usage: '3', selector: '1', matching: '1', data: '' },
	split(content) {
		const m = /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9A-Fa-f\s]+)$/.exec(content.trim());
		if (!m) return null;
		return {
			usage: m[1] as string,
			selector: m[2] as string,
			matching: m[3] as string,
			data: cleanHex(m[4] as string)
		};
	},
	join: (parts) => ({
		content: `${need(parts, 'usage')} ${need(parts, 'selector')} ${need(parts, 'matching')} ${cleanHex(need(parts, 'data'))}`
	}),
	check: (parts) => [
		...numberError(parts, 'usage', 'Usage', 0, 255),
		...numberError(parts, 'selector', 'Selector', 0, 255),
		...numberError(parts, 'matching', 'Matching type', 0, 255),
		...hexError(parts, 'data', 'Certificate data', { '1': 64, '2': 128 }, 'matching')
	],
	advise: (_parts, ctx) =>
		/^_\d+\._[a-z0-9-]+(\.|$)/.test(ctx.host)
			? []
			: ['A TLSA name normally starts with the port and the protocol, for example _443._tcp.']
};

const SSHFP: RecordKind = {
	type: 'SSHFP',
	title: 'SSH host key fingerprint',
	summary: "Publishes the fingerprint of a host's SSH key, so clients can verify it through DNS.",
	usesPrio: false,
	fields: [
		{
			key: 'algorithm',
			label: 'Key algorithm',
			kind: 'select',
			options: [
				{ value: '1', label: '1: RSA' },
				{ value: '2', label: '2: DSA' },
				{ value: '3', label: '3: ECDSA' },
				{ value: '4', label: '4: Ed25519' },
				{ value: '6', label: '6: Ed448' }
			]
		},
		{
			key: 'fptype',
			label: 'Fingerprint type',
			kind: 'select',
			options: [
				{ value: '1', label: '1: SHA-1' },
				{ value: '2', label: '2: SHA-256' }
			]
		},
		{
			key: 'fingerprint',
			label: 'Fingerprint',
			kind: 'long',
			hint: 'Hexadecimal, as printed by ssh-keygen -r.'
		}
	],
	defaults: { algorithm: '4', fptype: '2', fingerprint: '' },
	split(content) {
		const m = /^(\d+)\s+(\d+)\s+([0-9A-Fa-f\s]+)$/.exec(content.trim());
		if (!m) return null;
		return { algorithm: m[1] as string, fptype: m[2] as string, fingerprint: cleanHex(m[3] as string) };
	},
	join: (parts) => ({
		content: `${need(parts, 'algorithm')} ${need(parts, 'fptype')} ${cleanHex(need(parts, 'fingerprint'))}`
	}),
	check: (parts) => [
		...numberError(parts, 'algorithm', 'Key algorithm', 0, 255),
		...numberError(parts, 'fptype', 'Fingerprint type', 0, 255),
		...hexError(parts, 'fingerprint', 'The fingerprint', { '1': 40, '2': 64 }, 'fptype')
	]
};

/** HTTPS and SVCB share a format (RFC 9460): priority, target, then parameters. */
function serviceBinding(type: 'HTTPS' | 'SVCB', title: string, summary: string): RecordKind {
	return {
		type,
		title,
		summary,
		usesPrio: false,
		fields: [
			{
				key: 'priority',
				label: 'Priority',
				kind: 'number',
				min: 0,
				max: U16,
				hint: '0 makes the record an alias of the target. 1 or more describes a service.'
			},
			{
				key: 'target',
				label: 'Target',
				kind: 'text',
				placeholder: '.',
				hint: 'A hostname, or a single dot for this name itself.'
			},
			{
				key: 'params',
				label: 'Parameters',
				kind: 'text',
				placeholder: 'alpn="h3,h2"',
				hint: 'Optional, separated by spaces: alpn, port, ipv4hint, ipv6hint, ech.'
			}
		],
		defaults: { priority: '1', target: '.', params: '' },
		split(content) {
			const m = /^(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(content.trim());
			if (!m) return null;
			return { priority: m[1] as string, target: m[2] as string, params: (m[3] ?? '').trim() };
		},
		join(parts) {
			const params = need(parts, 'params').replace(/\s+/g, ' ');
			const head = `${need(parts, 'priority')} ${normaliseTarget(need(parts, 'target'))}`;
			return { content: params === '' ? head : `${head} ${params}` };
		},
		check(parts) {
			const errors = [
				...numberError(parts, 'priority', 'Priority', 0, U16),
				...targetError(parts, 'target', { allowRoot: true })
			];
			const params = need(parts, 'params');
			if (hasControlChar(params)) {
				errors.push({ part: 'params', message: 'The parameters must be on one line' });
			} else if (params !== '') {
				const bad = (params.match(/(?:[^\s"]|"[^"]*")+/g) ?? []).find(
					(p) => !/^[a-z0-9-]+(=("[^"]*"|[^\s"]+))?$/.test(p)
				);
				if (bad !== undefined) {
					errors.push({
						part: 'params',
						message: `"${bad}" is not a parameter: write them as key=value, separated by spaces`
					});
				}
			}
			return errors;
		},
		advise: (parts) =>
			need(parts, 'priority') === '0' && need(parts, 'params') !== ''
				? ['With priority 0 the record is an alias, and resolvers ignore its parameters.']
				: []
	};
}

const HTTPS = serviceBinding(
	'HTTPS',
	'HTTPS service',
	'Tells browsers how to reach the site over HTTPS before they connect: HTTP/3, other ports, address hints.'
);

const SVCB = serviceBinding(
	'SVCB',
	'Service binding',
	'The general form of the HTTPS record, for other protocols.'
);

const DS: RecordKind = {
	type: 'DS',
	title: 'DNSSEC delegation',
	summary:
		"Publishes the key digest of a delegated subdomain's zone. The DNSSEC records of the domain itself are on the Registry tab.",
	usesPrio: false,
	hostHint: 'The delegated subdomain, for example lab.',
	fields: [
		{ key: 'keyTag', label: 'Key tag', kind: 'number', min: 0, max: U16 },
		{
			key: 'algorithm',
			label: 'Algorithm',
			kind: 'select',
			options: [
				{ value: '8', label: '8: RSA/SHA-256' },
				{ value: '10', label: '10: RSA/SHA-512' },
				{ value: '13', label: '13: ECDSA P-256/SHA-256' },
				{ value: '14', label: '14: ECDSA P-384/SHA-384' },
				{ value: '15', label: '15: Ed25519' },
				{ value: '16', label: '16: Ed448' }
			]
		},
		{
			key: 'digestType',
			label: 'Digest type',
			kind: 'select',
			options: [
				{ value: '2', label: '2: SHA-256' },
				{ value: '4', label: '4: SHA-384' },
				{ value: '1', label: '1: SHA-1 (retired)' }
			]
		},
		{ key: 'digest', label: 'Digest', kind: 'long', hint: 'Hexadecimal.' }
	],
	defaults: { keyTag: '', algorithm: '13', digestType: '2', digest: '' },
	split(content) {
		const m = /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9A-Fa-f\s]+)$/.exec(content.trim());
		if (!m) return null;
		return {
			keyTag: m[1] as string,
			algorithm: m[2] as string,
			digestType: m[3] as string,
			digest: cleanHex(m[4] as string)
		};
	},
	join: (parts) => ({
		content: `${need(parts, 'keyTag')} ${need(parts, 'algorithm')} ${need(parts, 'digestType')} ${cleanHex(need(parts, 'digest'))}`
	}),
	check: (parts) => [
		...numberError(parts, 'keyTag', 'Key tag', 0, U16),
		...numberError(parts, 'algorithm', 'Algorithm', 0, 255),
		...numberError(parts, 'digestType', 'Digest type', 0, 255),
		...hexError(parts, 'digest', 'The digest', { '1': 40, '2': 64, '4': 96 }, 'digestType')
	],
	advise: (_parts, ctx) =>
		ctx.host === ''
			? ['The DNSSEC records of the domain itself are kept at the registry. Those are on the Registry tab.']
			: []
};

export const RECORD_KINDS: Readonly<Record<DnsRecordType, RecordKind>> = {
	A,
	AAAA,
	MX,
	CNAME,
	ALIAS,
	TXT,
	NS,
	SRV,
	TLSA,
	CAA,
	SSHFP,
	HTTPS,
	SVCB,
	DS
};

/** The types in the order the picker and the table use: the common ones first. */
export const KIND_ORDER: readonly DnsRecordType[] = DNS_RECORD_TYPES;

/** Position of a type for sorting; types this build does not know go last. */
export function typeRank(type: string): number {
	const at = (KIND_ORDER as readonly string[]).indexOf(type);
	return at < 0 ? KIND_ORDER.length : at;
}
