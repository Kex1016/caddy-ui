/**
 * Logging: `log`, `log_append`, `log_level`, `log_name`, `log_skip`.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import type { Directive } from '@caddy-ui/caddyfile';
import {
	arg,
	argList,
	argSelect,
	claimsOf,
	flag,
	group,
	note,
	section,
	subList,
	subSelect,
	subText,
	variant
} from '../fields';
import { getArg, setArg, sub } from '../node';
import { registerForm } from '../registry';
import type { FieldSpec, FormSpec, TextField, ToggleField } from '../types';
import { lineRows } from './helpers';
import { docsUrlOf, schemaFields } from './schema-fields';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'PANIC', 'FATAL'].map((v) => ({ value: v, label: v }));

/** `output file <path> { roll_* }`: the file name is the module's second argument. */
function outputField(schema: SchemaBundle | null): FieldSpec {
	const fileName: TextField = {
		kind: 'text',
		id: 'filename',
		label: 'File',
		type: 'path',
		required: true,
		placeholder: '/var/log/caddy/access.log',
		help: 'Point CADDY_LOG_PATH at this file so the dashboard can read it.',
		get: (n) => getArg(n, 1),
		set: (n, v) => setArg(n, 1, v === '' ? undefined : v)
	};
	const address: TextField = {
		kind: 'text',
		id: 'address',
		label: 'Address',
		type: 'string',
		required: true,
		placeholder: 'udp/localhost:5140',
		get: (n) => getArg(n, 1),
		set: (n, v) => setArg(n, 1, v === '' ? undefined : v)
	};
	const FILE = ['log', 'output', 'file'];
	return variant('output', {
		label: 'Write to',
		help: 'Where the log lines go. Default: stderr.',
		empty: 'Default (stderr)',
		options: [
			{
				value: 'file',
				label: 'A file',
				fields: [
					fileName,
					section(
						'Rotation',
						schemaFields(schema, FILE, [
							['roll_size', { label: 'Roll at size', help: 'Default 100MiB.' }],
							['roll_interval', { label: 'Roll every', help: 'A duration, such as 24h.' }],
							['roll_at', { label: 'Roll at times of day', help: 'Such as 00:00 12:00.' }],
							['roll_minutes', { label: 'Roll at minutes past the hour' }],
							['roll_keep', { label: 'Files to keep', help: 'Default 10.' }],
							['roll_keep_for', { label: 'Keep files for', help: 'Default 2160h (90 days).' }],
							['roll_local_time', { label: 'Use local time in file names' }],
							['roll_uncompressed', { label: 'Do not gzip rolled files' }],
							['roll_disabled', { label: 'Never roll' }],
							['backup_time_format', { label: 'Time format in rolled file names' }],
							['mode', { label: 'File mode', help: 'Such as 0640.' }]
						]),
						{ collapsed: true }
					)
				]
			},
			{
				value: 'net',
				label: 'A network address',
				fields: [
					address,
					...schemaFields(
						schema,
						['log', 'output', 'net'],
						[
							['dial_timeout', { label: 'Dial timeout' }],
							['soft_start', { label: 'Start even if the address is down' }]
						]
					)
				]
			},
			{ value: 'stdout', label: 'Standard output', fields: [] },
			{ value: 'stderr', label: 'Standard error', fields: [] },
			{ value: 'discard', label: 'Nowhere (discard)', fields: [] }
		]
	});
}

const FILTER_COLUMNS = [
	{ id: 'field', label: 'Field', type: 'string', placeholder: 'request>headers>Cookie' },
	{ id: 'filter', label: 'Filter', type: 'string', placeholder: 'delete' },
	{ id: 'a', label: 'Argument', type: 'string', optional: true },
	{ id: 'b', label: 'Argument', type: 'string', optional: true }
] as const;

function formatField(schema: SchemaBundle | null): FieldSpec {
	const encoderOptions = schemaFields(
		schema,
		['log', 'format'],
		[
			[
				'time_format',
				{
					label: 'Time format',
					help: 'unix_seconds_float (default), iso8601, rfc3339, wall, or a Go layout.'
				}
			],
			['time_local', { label: 'Local time instead of UTC' }],
			['duration_format', { label: 'Duration format' }],
			['level_format', { label: 'Level format' }],
			['time_key', { label: 'Time key' }],
			['message_key', { label: 'Message key' }],
			['level_key', { label: 'Level key' }],
			['name_key', { label: 'Logger name key' }],
			['caller_key', { label: 'Caller key' }],
			['stacktrace_key', { label: 'Stack trace key' }],
			['line_ending', { label: 'Line ending' }]
		]
	);
	const wrap = subText('wrap', {
		label: 'Wrapped encoder',
		help: 'The format the result is written in: json (default) or console. A filter block goes on that line as text.',
		literals: ['json', 'console', 'filter']
	});
	return variant('format', {
		label: 'Format',
		help: 'How each line is encoded. Default: JSON, which the dashboard needs.',
		empty: 'Default (JSON)',
		options: [
			{
				value: 'json',
				label: 'JSON',
				fields: [section('Encoder options', encoderOptions, { collapsed: true })]
			},
			{
				value: 'console',
				label: 'Console (human-readable)',
				fields: [section('Encoder options', encoderOptions, { collapsed: true })]
			},
			{
				value: 'filter',
				label: 'Filter fields',
				doc: 'Delete, mask or replace fields before the line is written.',
				fields: [
					lineRows({
						id: 'filters',
						label: 'Field filters',
						help: 'Field paths use > (request>headers>Cookie). Filters: delete, replace <value>, ip_mask <v4> <v6>, hash, regexp, query, cookie, rename. Filters with a block keep it.',
						columns: FILTER_COLUMNS,
						addLabel: 'Add filter',
						except: ['wrap', 'fields']
					}),
					wrap
				]
			},
			{
				value: 'append',
				label: 'Append fields',
				doc: 'Add fields to every line.',
				fields: [
					lineRows({
						id: 'appended',
						label: 'Fields to add',
						help: 'Values may be placeholders, such as {env.SERVER_ID}.',
						columns: [
							{ id: 'field', label: 'Field', type: 'string', placeholder: 'server_id' },
							{ id: 'value', label: 'Value', type: 'string', placeholder: '{env.SERVER_ID}' }
						],
						addLabel: 'Add field',
						except: ['wrap', 'fields']
					}),
					wrap
				]
			}
		]
	});
}

export function logForm(schema: SchemaBundle | null): FormSpec {
	const fields: FieldSpec[] = [
		arg(0, {
			id: 'logger-name',
			label: 'Logger name',
			placeholder: 'optional',
			help: 'Name it to send only some requests here with log_name, or to share it between sites.',
			placeholders: false
		}),
		outputField(schema),
		formatField(schema),
		subSelect('level', { label: 'Level', options: LEVELS, empty: 'Default (INFO)' }),
		section(
			'More',
			[
				subList('hostnames', {
					label: 'Only for these hostnames',
					help: 'Overrides the site addresses; useful in a snippet for wildcard sites.',
					placeholder: 'foo.example.com'
				}),
				flag('no_hostname', {
					label: 'Do not tie this log to the site’s hostnames',
					help: 'For a logger that only log_name sends requests to.'
				}),
				group('sampling', {
					label: 'Sampling',
					help: 'Log only some lines under load.',
					collapsed: true,
					fields: [
						subText('interval', { label: 'Interval', type: 'duration', placeholder: '1s' }),
						subText('first', {
							label: 'Log the first',
							type: 'int',
							placeholder: '100',
							help: 'Lines per interval logged in full.'
						}),
						subText('thereafter', {
							label: 'Then every',
							type: 'int',
							placeholder: '100',
							help: 'After that, log one in this many.'
						})
					]
				})
			],
			{ collapsed: true }
		)
	];
	return {
		name: 'log',
		title: 'Access log',
		summary: 'Log every request to this site.',
		docsUrl: docsUrlOf(schema, 'log'),
		fields,
		claims: claimsOf(fields),
		describe: (n) => {
			const out = sub(n, 'output');
			const where = out ? [out.args[0]?.text, out.args[1]?.text].filter(Boolean).join(' ') : 'stderr';
			return [getArg(n, 0), '→ ' + where].filter(Boolean).join(' ');
		}
	};
}

/** `log_append [<matcher>] [<]<key> <value>`: a `<` before the key reads the value before the handlers run. */
export function logAppendForm(schema: SchemaBundle | null): FormSpec {
	const early = (n: Directive) => getArg(n, 0)?.startsWith('<') ?? false;
	const key: TextField = {
		kind: 'text',
		id: 'key',
		label: 'Field',
		type: 'string',
		required: true,
		placeholder: 'upstream_host',
		placeholders: false,
		get: (n) => getArg(n, 0)?.replace(/^</, ''),
		set: (n, v) => setArg(n, 0, v ? (early(n) ? '<' + v : v) : undefined)
	};
	const before: ToggleField = {
		kind: 'toggle',
		id: 'early',
		label: 'Read the value before the request is handled',
		help: 'Use it to log the original path before a rewrite (the < prefix).',
		get: early,
		set: (n, on) => {
			const k = getArg(n, 0)?.replace(/^</, '') ?? '';
			if (on !== early(n)) setArg(n, 0, on ? '<' + k : k);
		}
	};
	return {
		name: 'log_append',
		title: 'Log field',
		summary: 'Add a field to the access log line of matching requests.',
		docsUrl: docsUrlOf(schema, 'log_append'),
		fields: [
			key,
			arg(1, {
				label: 'Value',
				required: true,
				placeholder: '{rp.upstream.host}',
				help: 'Usually a placeholder; {http.request.body} and {http.response.body} log the bodies.'
			}),
			before
		],
		claims: []
	};
}

export function logLevelForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'log_level',
		title: 'Log level',
		summary: 'Change the access log level of matching requests.',
		docsUrl: docsUrlOf(schema, 'log_level'),
		fields: [
			argSelect(0, {
				label: 'Level',
				options: LEVELS.slice(0, 4),
				help: 'A logger set to INFO drops lines at DEBUG, so this can quieten health checks.'
			})
		],
		claims: []
	};
}

export function logNameForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'log_name',
		title: 'Log to',
		summary: 'Send matching requests to named loggers.',
		docsUrl: docsUrlOf(schema, 'log_name'),
		fields: [
			argList(0, {
				label: 'Logger names',
				placeholder: 'health_check_log',
				help: 'Names given to log directives (log <name> { … }) or global log options.'
			})
		],
		claims: []
	};
}

export function logSkipForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'log_skip',
		title: 'Skip logging',
		summary: 'Do not write matching requests to the access log.',
		docsUrl: docsUrlOf(schema, 'log_skip'),
		fields: [
			note(
				'Pick which requests to skip with the matcher above, such as /static* or a named matcher for asset files. Without a matcher every request in this scope is skipped.'
			)
		],
		claims: []
	};
}

registerForm('log', logForm);
registerForm('log_append', logAppendForm);
registerForm('log_level', logLevelForm);
registerForm('log_name', logNameForm);
registerForm('log_skip', logSkipForm);
