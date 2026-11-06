/**
 * Headers and request shaping: `header`, `request_header`, `request_body`, `vars`, `map`, `method`,
 * `encode`, `push`.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { createDirective, type Directive } from '@caddy-ui/caddyfile';
import { arg, argList, flag, group, note, section, subText } from '../fields';
import { addSub, getArg, replaceArgs, setArgsFrom, setSub, sub } from '../node';
import { registerForm } from '../registry';
import type { Column, FieldSpec, FormSpec, ListField, TextField } from '../types';
import {
	HEADER_ROW_COLUMNS,
	HTTP_METHODS,
	bodyLines,
	lineRows,
	subArg,
	subArgSelect,
	writeSubArg
} from './helpers';
import { docsUrlOf } from './schema-fields';

const hasRows = (n: Directive, except: readonly string[]) => bodyLines(n, except).length > 0;

/**
 * `match` under `header` and `encode`: response conditions, inline (`match status 2xx`) or as a block
 * of response matchers (`match { header Content-Type text/* }`).
 */
function responseMatchGroup(): FieldSpec {
	return group('match', {
		label: 'Only when the response matches',
		help: 'Response conditions: status 2xx, header Content-Type text/*. Several lines in the block must all match.',
		collapsed: true,
		fields: [
			argList(0, { id: 'match-inline', label: 'Condition', placeholder: 'status 2xx' }),
			lineRows({
				id: 'match-rows',
				label: 'Conditions',
				columns: [
					{
						id: 'kind',
						label: 'Kind',
						type: 'string',
						options: [
							{ value: 'status', label: 'status' },
							{ value: 'header', label: 'header' }
						]
					},
					{ id: 'a', label: 'Value or header', type: 'string', placeholder: '2xx' },
					{ id: 'b', label: 'Header value', type: 'string', optional: true }
				],
				addLabel: 'Add condition'
			})
		]
	});
}

export function headerForm(schema: SchemaBundle | null): FormSpec {
	const EXCEPT = ['defer', 'match'];
	const fields: FieldSpec[] = [
		arg(0, {
			id: 'field',
			label: 'Header',
			type: 'header',
			placeholder: 'Strict-Transport-Security',
			help: 'Name alone sets it; -Name removes it; +Name adds another value; ?Name sets it only if missing; >Name changes it after the response is written.',
			placeholders: false,
			when: (n) => getArg(n, 0) !== undefined || !hasRows(n, EXCEPT)
		}),
		arg(1, {
			id: 'value',
			label: 'Value (or text to find)',
			placeholder: 'max-age=31536000;',
			when: (n) => getArg(n, 0) !== undefined && !getArg(n, 0)!.startsWith('-')
		}),
		arg(2, {
			id: 'replace',
			label: 'Replace with',
			help: 'With a replacement, the value above is a regexp to find in the existing header; $1 inserts a capture.',
			when: (n) => getArg(n, 1) !== undefined
		}),
		lineRows({
			id: 'operations',
			label: 'Header operations',
			help: 'One per line, with the same prefixes as above. Comments between lines stay where they are.',
			columns: HEADER_ROW_COLUMNS,
			addLabel: 'Add header',
			except: EXCEPT
		}),
		section(
			'When to apply',
			[
				flag('defer', {
					label: 'Apply after the response is written',
					help: 'Needed to change headers the backend sets. Implied by > and by removing a header.'
				}),
				responseMatchGroup()
			],
			{ collapsed: true }
		)
	];
	return {
		name: 'header',
		title: 'Response headers',
		summary: 'Set, add, remove or rewrite response headers.',
		docsUrl: docsUrlOf(schema, 'header'),
		fields,
		claims: ['defer', 'match'],
		claimsAllLines: true,
		describe: (n) => {
			const rows = bodyLines(n, EXCEPT).map((l) => l.name.text);
			return [...n.args.slice(0, 1).map((a) => a.text), ...rows].join(', ');
		}
	};
}

export function requestHeaderForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'request_header',
		title: 'Request headers',
		summary: 'Change a header on the request before later handlers see it.',
		docsUrl: docsUrlOf(schema, 'request_header'),
		fields: [
			arg(0, {
				id: 'field',
				label: 'Header',
				type: 'header',
				required: true,
				placeholder: 'X-Request-Id',
				help: 'Name alone sets it; -Name removes it (-*_* removes every header with an underscore); +Name adds a value.',
				placeholders: false
			}),
			arg(1, {
				id: 'value',
				label: 'Value (or text to find)',
				placeholder: '{http.request.uuid}',
				when: (n) => !(getArg(n, 0)?.startsWith('-') ?? false)
			}),
			arg(2, {
				id: 'replace',
				label: 'Replace with',
				help: 'With a replacement, the value above is a regexp to find.',
				when: (n) => getArg(n, 1) !== undefined
			})
		],
		claims: []
	};
}

export function requestBodyForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'request_body',
		title: 'Request body',
		summary: 'Limit or replace the request body.',
		docsUrl: docsUrlOf(schema, 'request_body'),
		fields: [
			subText('max_size', {
				label: 'Largest body allowed',
				type: 'size',
				placeholder: '10MB',
				help: 'Bigger requests get 413 Request Entity Too Large.'
			}),
			subText('set', {
				label: 'Replace the body with',
				multiline: true,
				placeholder: '{"query": "…"}',
				help: 'Placeholders work. Wrap JSON in backticks in the text view; the form quotes it for you.'
			})
		],
		claims: ['max_size', 'set']
	};
}

export function varsForm(schema: SchemaBundle | null): FormSpec {
	const inline = (n: Directive) => n.body === undefined;
	return {
		name: 'vars',
		title: 'Variables',
		summary: 'Set request variables, read later as {vars.name} or with the vars matcher.',
		docsUrl: docsUrlOf(schema, 'vars'),
		fields: [
			arg(0, { id: 'name', label: 'Name', placeholder: 'isFoo', placeholders: false, when: inline }),
			arg(1, { id: 'value', label: 'Value', placeholder: '"yep"', when: inline }),
			lineRows({
				id: 'vars',
				label: 'Variables',
				help: 'true, false and numbers keep their type; anything else is a string.',
				columns: [
					{ id: 'name', label: 'Name', type: 'string', placeholder: 'abc' },
					{ id: 'value', label: 'Value', type: 'string', placeholder: 'true' }
				],
				addLabel: 'Add variable',
				when: (n) => !inline(n)
			}),
			note('To set several at once, give this line a { } block in the text view.', {
				when: (n) => inline(n)
			})
		],
		claims: [],
		claimsAllLines: true,
		describe: (n) =>
			inline(n)
				? n.args.map((a) => a.text).join(' ')
				: bodyLines(n)
						.map((l) => l.name.text)
						.join(', ')
	};
}

/** `map <source> <dest…> { input outputs… ; default … }`: one output column per destination. */
export function mapForm(schema: SchemaBundle | null): FormSpec {
	const columnsFor = (n: Directive): Column[] => [
		{ id: 'input', label: 'Input', type: 'string', placeholder: 'example.com or ~regexp' },
		...n.args.slice(1).map((a, i): Column => ({
			id: `out${i}`,
			label: a.text,
			type: 'string',
			optional: i > 0,
			placeholder: '-'
		}))
	];
	const defaults: ListField = {
		kind: 'list',
		id: 'default',
		label: 'Defaults',
		type: 'string',
		help: 'One value per destination, used when no input matches.',
		get: (n) => sub(n, 'default')?.args.map((a) => a.text) ?? [],
		set: (n, v) => setSub(n, 'default', v.length ? v : undefined)
	};
	return {
		name: 'map',
		title: 'Map',
		summary: 'Set placeholders from another value, like a lookup table.',
		docsUrl: docsUrlOf(schema, 'map'),
		fields: [
			arg(0, {
				id: 'source',
				label: 'Look up',
				type: 'placeholder',
				required: true,
				placeholder: '{host}'
			}),
			argList(1, {
				id: 'destinations',
				label: 'Set these placeholders',
				type: 'placeholder',
				placeholder: '{my_placeholder}',
				help: 'Each one gets a column below; read them later as written, such as {my_placeholder}.'
			}),
			lineRows({
				id: 'mappings',
				label: 'Mappings',
				help: 'Inputs are exact unless they start with ~ (a regexp; ${1} inserts a capture). - leaves a destination unset.',
				columns: [
					{ id: 'input', label: 'Input', type: 'string' },
					{ id: 'out0', label: 'Output', type: 'string' }
				],
				columnsFor,
				addLabel: 'Add mapping',
				except: ['default']
			}),
			defaults
		],
		claims: ['default'],
		claimsAllLines: true
	};
}

export function methodForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'method',
		title: 'Change method',
		summary: 'Change the HTTP method of the request internally.',
		docsUrl: docsUrlOf(schema, 'method'),
		fields: [
			arg(0, {
				id: 'method',
				label: 'Method',
				required: true,
				literals: HTTP_METHODS,
				placeholder: 'POST',
				placeholders: false
			})
		],
		claims: []
	};
}

const ENCODINGS = ['zstd', 'gzip'] as const;

/**
 * `encode [formats…] { gzip [level]; zstd [level]; minimum_length; match }`. A format may be named on
 * the line or as a body line; the list shows both and adds new ones on the line.
 */
export function encodeForm(schema: SchemaBundle | null): FormSpec {
	const formats: ListField = {
		kind: 'list',
		id: 'formats',
		label: 'Encodings',
		type: 'string',
		choices: [
			{ value: 'zstd', label: 'zstd' },
			{ value: 'gzip', label: 'gzip' }
		],
		help: 'None ticked means zstd and gzip, Caddy’s default. Clients pick the first they support.',
		get: (n) => [
			...n.args.map((a) => a.text),
			...ENCODINGS.filter((e) => sub(n, e) && !n.args.some((a) => a.text === e))
		],
		set: (n, values) => {
			for (const e of ENCODINGS) if (!values.includes(e) && sub(n, e)) setSub(n, e, undefined);
			const onLine = (v: string) => n.args.some((a) => a.text === v);
			setArgsFrom(
				n,
				0,
				values.filter((v) => onLine(v) || sub(n, v) === undefined)
			);
		}
	};
	/** Setting a level moves the format from the line into the block, where a level can go. */
	const level = (e: 'gzip' | 'zstd', field: TextField): TextField => ({
		...field,
		set: (n, v) => {
			if (v) {
				if (n.args.some((a) => a.text === e))
					replaceArgs(
						n,
						n.args.map((a) => a.text).filter((t) => t !== e)
					);
				if (!sub(n, e)) addSub(n, createDirective(e, []));
			}
			writeSubArg(n, e, 0, v, true);
		}
	});
	const gzip = level(
		'gzip',
		subArg('gzip', 0, {
			label: 'gzip level',
			type: 'int',
			placeholder: '5',
			help: '1 (fastest) to 9 (smallest).'
		})
	);
	const zstdSel = subArgSelect('zstd', 0, {
		label: 'zstd level',
		keepLine: true,
		options: ['fastest', 'default', 'better', 'best'].map((v) => ({ value: v, label: v })),
		empty: 'Default'
	});
	const zstd = {
		...zstdSel,
		set: (n: Directive, v: string | undefined) => {
			if (v) {
				if (n.args.some((a) => a.text === 'zstd'))
					replaceArgs(
						n,
						n.args.map((a) => a.text).filter((t) => t !== 'zstd')
					);
				if (!sub(n, 'zstd')) addSub(n, createDirective('zstd', []));
			}
			writeSubArg(n, 'zstd', 0, v, true);
		}
	};
	return {
		name: 'encode',
		title: 'Compression',
		summary: 'Compress responses for clients that accept it.',
		docsUrl: docsUrlOf(schema, 'encode'),
		fields: [
			formats,
			section(
				'Options',
				[
					gzip,
					zstd,
					subText('minimum_length', {
						label: 'Smallest response to compress',
						type: 'int',
						placeholder: '512',
						help: 'In bytes. Default 512.'
					}),
					responseMatchGroup()
				],
				{
					collapsed: true,
					help: 'By default most text types are compressed when the response is at least 512 bytes.'
				}
			)
		],
		claims: ['gzip', 'zstd', 'minimum_length', 'match']
	};
}

/** `push [<matcher>] [<resource>] { [GET|HEAD] <resource>; headers { … } }`. */
export function pushForm(schema: SchemaBundle | null): FormSpec {
	const isMethod = (t: string) => t === 'GET' || t === 'HEAD';
	return {
		name: 'push',
		title: 'HTTP/2 push',
		summary: 'Push resources to the client before it asks (most browsers ignore this now).',
		docsUrl: docsUrlOf(schema, 'push'),
		fields: [
			arg(0, {
				id: 'resource',
				label: 'Resource',
				type: 'path',
				placeholder: '/resources/style.css',
				help: 'Without a resource, Caddy pushes what the response’s Link headers name.'
			}),
			lineRows({
				id: 'resources',
				label: 'More resources',
				columns: [
					{
						id: 'method',
						label: 'Method',
						type: 'string',
						optional: true,
						options: [
							{ value: 'GET', label: 'GET' },
							{ value: 'HEAD', label: 'HEAD' }
						]
					},
					{ id: 'resource', label: 'Resource', type: 'path', placeholder: '/app.js' }
				],
				addLabel: 'Add resource',
				except: ['headers'],
				toRow: (l) => (isMethod(l.name.text) ? [l.name.text, l.args[0]?.text ?? ''] : ['', l.name.text]),
				fromRow: ([m = '', r = '']) => (r === '' ? undefined : m ? [m, [r]] : [r, []])
			}),
			group('headers', {
				label: 'Headers on the push requests',
				collapsed: true,
				fields: [
					lineRows({
						id: 'push-headers',
						label: 'Headers',
						columns: HEADER_ROW_COLUMNS,
						addLabel: 'Add header'
					})
				]
			})
		],
		claims: ['headers'],
		claimsAllLines: true
	};
}

registerForm('header', headerForm);
registerForm('request_header', requestHeaderForm);
registerForm('request_body', requestBodyForm);
registerForm('vars', varsForm);
registerForm('map', mapForm);
registerForm('method', methodForm);
registerForm('encode', encodeForm);
registerForm('push', pushForm);
