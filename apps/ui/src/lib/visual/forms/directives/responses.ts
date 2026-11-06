/**
 * Responses and routing extras: `respond`, `error`, `abort`, `intercept`, `invoke`, `bind`, `metrics`,
 * `tracing`, `timeouts`, `basic_auth`.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { createDirective, createMatcherRef, type Directive } from '@caddy-ui/caddyfile';
import { pruneEmptyBody } from '../../document';
import { arg, argList, argSelect, flag, group, note, section, subText } from '../fields';
import { addSub, getArg, replaceArgs, subs } from '../node';
import { registerForm } from '../registry';
import type { FormSpec, RowsField, TextField } from '../types';
import { isStatusCode, lineRows, subArg } from './helpers';
import { docsUrlOf } from './schema-fields';

/**
 * `<status_or_text> [<status>]`: one argument is a status when it is a three-digit code, the text
 * otherwise; two are text then status. The two fields read and write that pair.
 */
function textAndStatus(o: {
	textLabel: string;
	textHelp: string;
	textPlaceholder: string;
	statusHelp: string;
	statusPlaceholder: string;
	/** Hide the text field when the text lives in a body line (`body`, `message`). */
	bodyLine: string;
}): [TextField, TextField] {
	const textOf = (n: Directive) => {
		const [a, b] = n.args.map((t) => t.text);
		if (b !== undefined) return a;
		return a !== undefined && !isStatusCode(a) ? a : undefined;
	};
	const statusOf = (n: Directive) => {
		const [a, b] = n.args.map((t) => t.text);
		if (b !== undefined) return b;
		return isStatusCode(a) ? a : undefined;
	};
	const write = (n: Directive, text: string | undefined, status: string | undefined) =>
		replaceArgs(n, [...(text !== undefined && text !== '' ? [text] : []), ...(status ? [status] : [])]);
	return [
		{
			kind: 'text',
			id: 'text',
			label: o.textLabel,
			help: o.textHelp,
			type: 'string',
			multiline: true,
			placeholder: o.textPlaceholder,
			when: (n) => textOf(n) !== undefined || subs(n, o.bodyLine).length === 0,
			get: textOf,
			set: (n, v) => {
				// a text that looks like a status code would be read as one: quote-proof it by keeping the
				// status explicit
				const status = statusOf(n) ?? (v !== undefined && isStatusCode(v) ? '200' : undefined);
				write(n, v, status);
			}
		},
		{
			kind: 'text',
			id: 'status',
			label: 'Status',
			help: o.statusHelp,
			type: 'status',
			placeholder: o.statusPlaceholder,
			get: statusOf,
			set: (n, v) => write(n, textOf(n), v || undefined)
		}
	];
}

export function respondForm(schema: SchemaBundle | null): FormSpec {
	const [text, status] = textAndStatus({
		textLabel: 'Body',
		textHelp: 'Placeholders work. Set a Content-Type with the header directive for HTML or JSON.',
		textPlaceholder: 'Hello, world!',
		statusHelp: 'Default 200.',
		statusPlaceholder: '200',
		bodyLine: 'body'
	});
	return {
		name: 'respond',
		title: 'Respond',
		summary: 'Answer the request directly with a status and an optional body.',
		docsUrl: docsUrlOf(schema, 'respond'),
		fields: [
			text,
			status,
			subText('body', {
				label: 'Body (block form)',
				multiline: true,
				when: (n) => subs(n, 'body').length > 0
			}),
			flag('close', {
				label: 'Close the connection after responding',
				help: 'Sends Connection: close and drops the client.'
			})
		],
		claims: ['body', 'close'],
		describe: (n) => n.args.map((a) => (a.text.length > 32 ? a.text.slice(0, 31) + '…' : a.text)).join(' ')
	};
}

export function errorForm(schema: SchemaBundle | null): FormSpec {
	const [text, status] = textAndStatus({
		textLabel: 'Message',
		textHelp: 'Available to handle_errors as {err.message}; never sent to the client by itself.',
		textPlaceholder: 'Unauthorized',
		statusHelp: 'Default 500. handle_errors sees it as {err.status_code}.',
		statusPlaceholder: '403',
		bodyLine: 'message'
	});
	return {
		name: 'error',
		title: 'Error',
		summary: 'Fail the request with an error that handle_errors can turn into a page.',
		docsUrl: docsUrlOf(schema, 'error'),
		fields: [
			text,
			status,
			subText('message', {
				label: 'Message (block form)',
				when: (n) => subs(n, 'message').length > 0
			})
		],
		claims: ['message']
	};
}

export function abortForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'abort',
		title: 'Abort',
		summary: 'Drop the connection without answering.',
		docsUrl: docsUrlOf(schema, 'abort'),
		fields: [
			note(
				'The client gets no response at all. Pick which requests with the matcher above; without one, every request in this scope is dropped (useful as the last handle on a wildcard site).'
			)
		],
		claims: []
	};
}

/** `replace_status [<response_matcher>] <code>` lines, the matcher in the first column. */
function replaceStatusRows(): RowsField {
	return {
		kind: 'rows',
		id: 'replace_status',
		label: 'Replace the status',
		help: 'With a response matcher (@name, defined in this block) only matching responses change.',
		columns: [
			{ id: 'matcher', label: 'Response matcher', type: 'matcher', optional: true, placeholder: '@404' },
			{ id: 'status', label: 'New status', type: 'status', placeholder: '200' }
		],
		addLabel: 'Add status replacement',
		get: (n) => subs(n, 'replace_status').map((l) => [l.matcher?.text ?? '', l.args[0]?.text ?? '']),
		set: (n, rows) => {
			const lines = subs(n, 'replace_status');
			const wanted = rows.filter((r) => (r[1] ?? '') !== '');
			wanted.forEach(([m = '', code = ''], i) => {
				let line = lines[i];
				if (!line) line = addSub(n, createDirective('replace_status', []));
				if ((line.matcher?.text ?? '') !== m) {
					if (m.startsWith('@')) line.matcher = createMatcherRef(m);
					else delete line.matcher;
				}
				replaceArgs(line, [code]);
			});
			if (lines.length > wanted.length) {
				const drop = new Set(lines.slice(wanted.length));
				n.body = (n.body ?? []).filter((x) => !drop.has(x as Directive));
				pruneEmptyBody(n);
			}
		}
	};
}

export function interceptForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'intercept',
		title: 'Intercept responses',
		summary: 'Act on the response of the handlers after it, such as X-Accel-Redirect or error pages.',
		docsUrl: docsUrlOf(schema, 'intercept'),
		fields: [
			replaceStatusRows(),
			note(
				'Response matchers (@name { status 404 } or header X-Accel-Redirect *) and handle_response blocks appear as children in the tree. Inside handle_response, {resp.status_code} and {resp.header.*} hold the intercepted response.'
			)
		],
		claims: ['replace_status', 'handle_response']
	};
}

export function invokeForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'invoke',
		title: 'Invoke route',
		summary: 'Run a named route defined at the top of the file (&(name) { … }).',
		docsUrl: docsUrlOf(schema, 'invoke'),
		fields: [
			arg(0, {
				id: 'route',
				label: 'Route name',
				required: true,
				placeholder: 'app-proxy',
				placeholders: false,
				help: 'A named route is set up once and shared by every site that invokes it, unlike an imported snippet.'
			})
		],
		claims: []
	};
}

export function bindForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'bind',
		title: 'Bind',
		summary: 'Listen only on these interfaces instead of all of them.',
		docsUrl: docsUrlOf(schema, 'bind'),
		fields: [
			argList(0, {
				id: 'hosts',
				label: 'Addresses',
				placeholder: '127.0.0.1',
				help: 'IP addresses ([::1] for IPv6), tcp4/ or udp/ prefixes, or a socket: unix//run/caddy (|0222 sets the file mode).'
			})
		],
		claims: []
	};
}

export function metricsForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'metrics',
		title: 'Metrics endpoint',
		summary: 'Serve Prometheus metrics at this path.',
		docsUrl: docsUrlOf(schema, 'metrics'),
		fields: [
			flag('disable_openmetrics', {
				label: 'Plain Prometheus format only',
				help: 'Turns off OpenMetrics negotiation, for scrapers that do not support it.'
			}),
			note(
				'The path comes from the matcher above (usually /metrics). This UI reads metrics from the admin API instead, which needs the global metrics option, not this directive.'
			)
		],
		claims: ['disable_openmetrics']
	};
}

export function tracingForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'tracing',
		title: 'Tracing',
		summary: 'Send OpenTelemetry traces for matching requests.',
		docsUrl: docsUrlOf(schema, 'tracing'),
		fields: [
			subText('span', {
				label: 'Span name',
				placeholder: 'api',
				help: 'Placeholders work. The exporter is configured with OTEL_* environment variables.'
			}),
			group('span_attributes', {
				label: 'Span attributes',
				collapsed: true,
				fields: [
					lineRows({
						id: 'attributes',
						label: 'Attributes',
						columns: [
							{ id: 'name', label: 'Attribute', type: 'string', placeholder: 'user_id' },
							{ id: 'value', label: 'Value', type: 'string', placeholder: '{http.request.cookie.user-id}' }
						],
						addLabel: 'Add attribute'
					})
				]
			})
		],
		claims: ['span', 'span_attributes']
	};
}

export function timeoutsForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'timeouts',
		title: 'Timeouts',
		summary: 'Per-request read and write timeouts, for slow uploads or downloads.',
		docsUrl: docsUrlOf(schema, 'timeouts'),
		fields: [
			subArg('read_timeout', 0, {
				label: 'Read timeout',
				type: 'duration',
				placeholder: '10s',
				help: 'How long reading the request body may take.'
			}),
			subArg('read_timeout', 1, {
				label: 'Minimum read rate',
				placeholder: '1024',
				help: 'Bytes per second; slower clients are cut off.',
				when: (n) => subs(n, 'read_timeout').length > 0
			}),
			subArg('write_timeout', 0, {
				label: 'Write timeout',
				type: 'duration',
				placeholder: '30s',
				help: 'How long writing the response may take.'
			}),
			subArg('write_timeout', 1, {
				label: 'Minimum write rate',
				placeholder: '1024',
				when: (n) => subs(n, 'write_timeout').length > 0
			}),
			subText('max_write_chunk', { label: 'Largest write chunk', type: 'size', placeholder: '16KiB' })
		],
		claims: ['read_timeout', 'write_timeout', 'max_write_chunk']
	};
}

export function basicAuthForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'basic_auth',
		title: 'Basic auth',
		summary: 'Ask for a username and password.',
		docsUrl: docsUrlOf(schema, 'basic_auth'),
		fields: [
			lineRows({
				id: 'users',
				label: 'Users',
				help: 'Passwords are stored hashed: run caddy hash-password in the Caddy container and paste the result.',
				columns: [
					{ id: 'user', label: 'Username', type: 'string', placeholder: 'Bob' },
					{ id: 'hash', label: 'Password hash', type: 'string', placeholder: '$2a$14$…' }
				],
				addLabel: 'Add user'
			}),
			section(
				'Options',
				[
					argSelect(0, {
						id: 'algorithm',
						label: 'Hash algorithm',
						options: [
							{ value: 'bcrypt', label: 'bcrypt' },
							{ value: 'argon2id', label: 'argon2id' }
						],
						empty: 'Default (bcrypt)',
						help: 'Must match how the hashes were made (caddy hash-password --algorithm).'
					}),
					{
						...arg(1, {
							id: 'realm',
							label: 'Realm',
							placeholder: 'restricted',
							help: 'Shown by some browsers in the login prompt.'
						}),
						set: (n: Directive, v: string | undefined) => {
							const algo = getArg(n, 0) ?? 'bcrypt';
							replaceArgs(n, v ? [algo, v] : n.args.slice(0, 1).map((a) => a.text));
						}
					}
				],
				{ collapsed: true }
			)
		],
		claims: [],
		claimsAllLines: true,
		describe: (n) => {
			const users = (n.body ?? []).filter((x) => x.kind === 'directive').length;
			return `${users} user${users === 1 ? '' : 's'}`;
		}
	};
}

registerForm('respond', respondForm);
registerForm('error', errorForm);
registerForm('abort', abortForm);
registerForm('intercept', interceptForm);
registerForm('invoke', invokeForm);
registerForm('bind', bindForm);
registerForm('metrics', metricsForm);
registerForm('tracing', tracingForm);
registerForm('timeouts', timeoutsForm);
registerForm('basic_auth', basicAuthForm);
