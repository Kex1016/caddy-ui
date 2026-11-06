/**
 * Bespoke forms for the matcher modules W5a left to the schema: `client_ip`, `remote_ip`, `file`,
 * `header`, `header_regexp`, `host`, `method`, `protocol`, `query`, `tls`, `url_pattern`, `vars`,
 * `vars_regexp`. Together with `path`, `path_regexp`, `expression` and `not` (in `index.ts`) and the
 * named, path-token and wildcard forms of the matcher slot, every matcher has a hand-made form.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import type { Directive } from '@caddy-ui/caddyfile';
import { arg, argList, argSelect, flag, note, subList, subSelect, subText } from '../fields';
import { getArg, replaceArgs } from '../node';
import { registerMatcherForm } from '../registry';
import type { FormSpec, RowsField, TextField, ToggleField } from '../types';
import { HTTP_METHODS, optionalNameFields } from '../directives/helpers';

const docs = (schema: SchemaBundle | null, name: string) =>
	schema?.matchers[name]?.docsUrl ??
	`https://caddyserver.com/docs/caddyfile/matchers#${name.replace(/_/g, '-')}`;

function ipForm(schema: SchemaBundle | null, name: 'client_ip' | 'remote_ip'): FormSpec {
	return {
		name,
		title: name === 'client_ip' ? 'Client IP' : 'Remote IP',
		summary:
			name === 'client_ip'
				? 'The client’s IP, read from X-Forwarded-For when the request came through a trusted proxy.'
				: 'The IP of the direct connection, ignoring X-Forwarded-For. Usually you want client_ip.',
		docsUrl: docs(schema, name),
		fields: [
			argList(0, {
				label: 'IP addresses or ranges',
				placeholder: '10.0.0.0/8',
				literals: ['private_ranges'],
				help: 'CIDR ranges or single IPs; private_ranges covers every private network. Any one matches.'
			}),
			note('Trusted proxies are set with the global servers { trusted_proxies } option.', {
				when: () => name === 'client_ip'
			})
		],
		claims: []
	};
}

export function fileMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'file',
		title: 'File exists',
		summary:
			'Matches when a file exists on disk, and rewrites nothing by itself; {file_match.relative} holds the hit.',
		docsUrl: docs(schema, 'file'),
		fields: [
			argList(0, {
				label: 'Files to try',
				type: 'path',
				placeholder: '{path}.html',
				help: 'In order; a trailing / tests a folder, =404 ends the list with that status. Empty means {path}.'
			}),
			subList('try_files', {
				label: 'Files to try (block form)',
				type: 'path',
				placeholder: '{path}',
				when: (n) => n.body !== undefined
			}),
			subSelect('try_policy', {
				label: 'Pick',
				options: [
					{ value: 'first_exist', label: 'First that exists (default)' },
					{ value: 'first_exist_fallback', label: 'First that exists, else the last' },
					{ value: 'smallest_size', label: 'Smallest file' },
					{ value: 'largest_size', label: 'Largest file' },
					{ value: 'most_recently_modified', label: 'Most recently modified' }
				]
			}),
			subText('root', { label: 'Root', type: 'path', help: 'Default: the site root.' }),
			subList('split_path', { label: 'Split path at', placeholder: '.php' })
		],
		claims: ['try_files', 'try_policy', 'root', 'split_path']
	};
}

/** `header <field> [<value>]`; `!Field` matches when the header is absent. */
export function headerMatcherForm(schema: SchemaBundle | null): FormSpec {
	const absent = (n: Directive) => getArg(n, 0)?.startsWith('!') ?? false;
	const field: TextField = {
		kind: 'text',
		id: 'field',
		label: 'Header',
		type: 'header',
		required: true,
		placeholder: 'Connection',
		placeholders: false,
		get: (n) => getArg(n, 0)?.replace(/^!/, ''),
		set: (n, v) => {
			const rest = n.args.slice(1).map((a) => a.text);
			replaceArgs(n, v ? [(absent(n) ? '!' : '') + v, ...rest] : []);
		}
	};
	const missing: ToggleField = {
		kind: 'toggle',
		id: 'absent',
		label: 'Match when the header is missing',
		get: absent,
		set: (n, on) => {
			if (on === absent(n)) return;
			const f = getArg(n, 0)?.replace(/^!/, '') ?? '';
			replaceArgs(n, on ? ['!' + f] : [f]);
		}
	};
	return {
		name: 'header',
		title: 'Header',
		summary: 'Matches a request header. Several header lines must all match.',
		docsUrl: docs(schema, 'header'),
		fields: [
			field,
			arg(1, {
				id: 'value',
				label: 'Value',
				placeholder: '*Upgrade*',
				help: 'Exact, or with * at either end: *Upgrade* contains it. Empty means the header is present with any value.',
				when: (n) => !absent(n)
			}),
			missing
		],
		claims: []
	};
}

export function headerRegexpMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'header_regexp',
		title: 'Header regexp',
		summary: 'Matches a request header against a regexp and captures parts of it.',
		docsUrl: docs(schema, 'header_regexp'),
		fields: optionalNameFields([
			{ id: 'field', label: 'Header', type: 'header', placeholder: 'Cookie', placeholders: false },
			{
				id: 'regexp',
				label: 'Regular expression',
				type: 'regexp',
				placeholder: 'login_([a-f0-9]+)',
				placeholders: false
			}
		]),
		claims: []
	};
}

export function hostMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'host',
		title: 'Host',
		summary: 'Matches the Host of the request. Any one of the names matches.',
		docsUrl: docs(schema, 'host'),
		fields: [
			argList(0, {
				label: 'Hosts',
				placeholder: 'sub.example.com',
				help: 'Exact names, or *.example.com for one level of subdomains. Useful on wildcard sites.'
			})
		],
		claims: []
	};
}

export function methodMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'method',
		title: 'Method',
		summary: 'Matches the HTTP method. Any one of them matches.',
		docsUrl: docs(schema, 'method'),
		fields: [
			argList(0, {
				label: 'Methods',
				placeholder: 'GET',
				literals: HTTP_METHODS,
				help: 'Upper case: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.'
			})
		],
		claims: []
	};
}

export function protocolMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'protocol',
		title: 'Protocol',
		summary: 'Matches the protocol of the request.',
		docsUrl: docs(schema, 'protocol'),
		fields: [
			arg(0, {
				id: 'protocol',
				label: 'Protocol',
				required: true,
				placeholder: 'https',
				placeholders: false,
				literals: ['http', 'https', 'grpc', 'http/1.1', 'http/2', 'http/2+', 'http/3'],
				help: 'http, https, grpc, or an HTTP version; a trailing + means that version or newer.'
			})
		],
		claims: []
	};
}

/** `query key=val …` as key/value rows; `query ""` (no query string at all) as a toggle. */
export function queryMatcherForm(schema: SchemaBundle | null): FormSpec {
	const isEmptyQuery = (n: Directive) => n.args.some((a) => a.text === '');
	const pairs: RowsField = {
		kind: 'rows',
		id: 'pairs',
		label: 'Parameters',
		help: 'The value may use * as a wildcard. The same key twice matches either value; different keys must all match.',
		columns: [
			{ id: 'key', label: 'Key', type: 'string', placeholder: 'q' },
			{ id: 'value', label: 'Value', type: 'string', optional: true, placeholder: '*' }
		],
		addLabel: 'Add parameter',
		when: (n) => !isEmptyQuery(n),
		get: (n) =>
			n.args
				.filter((a) => a.text !== '')
				.map((a) => {
					const i = a.text.indexOf('=');
					return i === -1 ? [a.text] : [a.text.slice(0, i), a.text.slice(i + 1)];
				}),
		set: (n, rows) =>
			replaceArgs(
				n,
				rows
					.filter((r) => (r[0] ?? '') !== '' || (r[1] ?? '') !== '')
					.map((r) => (r.length > 1 ? `${r[0] ?? ''}=${r[1] ?? ''}` : (r[0] ?? '')))
			)
	};
	const none: ToggleField = {
		kind: 'toggle',
		id: 'no-query',
		label: 'Match requests with no query string',
		get: isEmptyQuery,
		set: (n, on) => {
			if (on === isEmptyQuery(n)) return;
			replaceArgs(n, on ? [''] : []);
		}
	};
	return {
		name: 'query',
		title: 'Query',
		summary: 'Matches query string parameters.',
		docsUrl: docs(schema, 'query'),
		fields: [pairs, none],
		claims: []
	};
}

export function tlsMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'tls',
		title: 'TLS',
		summary: 'Matches requests that came over TLS.',
		docsUrl: docs(schema, 'tls'),
		fields: [
			argSelect(0, {
				id: 'state',
				label: 'Only',
				options: [{ value: 'early_data', label: 'TLS 1.3 early data (0-RTT), which can be replayed' }],
				empty: 'Any TLS connection',
				help: 'Answer early-data requests that are not safe to replay with 425 Too Early.'
			})
		],
		claims: []
	};
}

export function urlPatternMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'url_pattern',
		title: 'URL pattern',
		summary: 'Matches the URL against a URL Pattern (the web standard) and captures named parts.',
		docsUrl: docs(schema, 'url_pattern'),
		fields: [
			arg(0, {
				id: 'pattern',
				label: 'Pattern',
				required: true,
				placeholder: '/books/:id([0-9]+)',
				placeholders: false,
				help: ':name captures a segment, read as {http.url_pattern.pathname.name}; {/*}? makes a part optional.'
			}),
			subText('base_url', {
				label: 'Base URL',
				type: 'url',
				placeholder: 'https://example.com',
				help: 'For relative patterns.'
			}),
			flag('ignore_case', { label: 'Ignore case' })
		],
		claims: ['base_url', 'ignore_case']
	};
}

export function varsMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'vars',
		title: 'Variable',
		summary: 'Matches a request variable or placeholder against values.',
		docsUrl: docs(schema, 'vars'),
		fields: [
			arg(0, {
				id: 'variable',
				label: 'Variable or placeholder',
				required: true,
				placeholder: '{magic_number}',
				help: 'A name set with the vars directive, or any placeholder such as {http.auth.user.id}.'
			}),
			argList(1, { label: 'Values', placeholder: '3', help: 'Any one matches.' })
		],
		claims: []
	};
}

export function varsRegexpMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'vars_regexp',
		title: 'Variable regexp',
		summary: 'Matches a variable or placeholder against a regexp and captures parts of it.',
		docsUrl: docs(schema, 'vars_regexp'),
		fields: optionalNameFields([
			{ id: 'variable', label: 'Variable or placeholder', placeholder: '{magic_number}' },
			{
				id: 'regexp',
				label: 'Regular expression',
				type: 'regexp',
				placeholder: '^(4.*)',
				placeholders: false
			}
		]),
		claims: []
	};
}

registerMatcherForm('client_ip', (s) => ipForm(s, 'client_ip'));
registerMatcherForm('remote_ip', (s) => ipForm(s, 'remote_ip'));
registerMatcherForm('file', fileMatcherForm);
registerMatcherForm('header', headerMatcherForm);
registerMatcherForm('header_regexp', headerRegexpMatcherForm);
registerMatcherForm('host', hostMatcherForm);
registerMatcherForm('method', methodMatcherForm);
registerMatcherForm('protocol', protocolMatcherForm);
registerMatcherForm('query', queryMatcherForm);
registerMatcherForm('tls', tlsMatcherForm);
registerMatcherForm('url_pattern', urlPatternMatcherForm);
registerMatcherForm('vars', varsMatcherForm);
registerMatcherForm('vars_regexp', varsRegexpMatcherForm);
