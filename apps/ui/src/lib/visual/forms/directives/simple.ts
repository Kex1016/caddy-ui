/**
 * `redir`, `rewrite`, `try_files`, `import`: one-line directives with a field per argument.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import type { Directive } from '@caddy-ui/caddyfile';
import { arg, argList, argSelect, note, subSelect } from '../fields';
import { getArg, setArg } from '../node';
import { registerForm } from '../registry';
import type { FieldSpec, FormSpec, SelectField, TextField } from '../types';
import { docsUrlOf } from './schema-fields';

export const REDIR_CODES = [
	{ value: 'permanent', label: 'Permanent (301)' },
	{ value: 'temporary', label: 'Temporary (302, the default)' },
	{ value: '301', label: '301 Moved Permanently' },
	{ value: '302', label: '302 Found' },
	{ value: '303', label: '303 See Other' },
	{ value: '307', label: '307 Temporary Redirect' },
	{ value: '308', label: '308 Permanent Redirect' },
	{ value: 'html', label: 'HTML page with a meta refresh' },
	{ value: '401', label: '401 with a Location header' }
];

export function redirForm(schema: SchemaBundle | null): FormSpec {
	const code: SelectField = argSelect(1, {
		label: 'Status',
		options: REDIR_CODES,
		empty: 'Default (302 temporary)',
		help: 'Browsers cache permanent redirects; use temporary while testing.'
	});
	// A placeholder or unusual code that is not in the list is kept as typed.
	const isCustom = (n: Directive) => {
		const v = getArg(n, 1);
		return v !== undefined && !REDIR_CODES.some((o) => o.value === v);
	};
	const custom: TextField = {
		kind: 'text',
		id: 'code-custom',
		label: 'Status (as written)',
		type: 'status',
		get: (n) => getArg(n, 1),
		set: (n, v) => setArg(n, 1, v),
		when: isCustom
	};
	const fields: FieldSpec[] = [
		arg(0, {
			label: 'Redirect to',
			type: 'url',
			required: true,
			placeholder: 'https://example.com{uri}',
			help: 'Add {uri} to keep the path and query of the request.'
		}),
		{ ...code, when: (n) => !isCustom(n) },
		custom
	];
	return {
		name: 'redir',
		title: 'Redirect',
		summary: 'Send the client somewhere else.',
		docsUrl: docsUrlOf(schema, 'redir'),
		fields,
		claims: []
	};
}

export function rewriteForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'rewrite',
		title: 'Rewrite',
		summary: 'Change the request path or query internally; the client does not see it.',
		docsUrl: docsUrlOf(schema, 'rewrite'),
		fields: [
			arg(0, {
				label: 'Rewrite to',
				type: 'path',
				required: true,
				placeholder: '/index.html{uri}',
				help: 'A path, a ?query, or both (/new?x=1). Only the parts given are changed: ?direct=true keeps the path.'
			}),
			note('With a /path matcher Caddy needs the * wildcard token first: rewrite * ?gallery=true.', {
				when: (n) => n.matcher === undefined && (getArg(n, 0)?.startsWith('?') ?? false)
			})
		],
		claims: []
	};
}

export function tryFilesForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'try_files',
		title: 'Try files',
		summary: 'Rewrite to the first file that exists.',
		docsUrl: docsUrlOf(schema, 'try_files'),
		fields: [
			argList(0, {
				label: 'Files to try, in order',
				type: 'path',
				placeholder: '{path}',
				help: 'Usually {path} first, then a fallback such as /index.html. A trailing / tests for a directory; =404 answers with that status.'
			}),
			subSelect('policy', {
				label: 'Pick',
				options: [
					{ value: 'first_exist', label: 'First that exists (default)' },
					{ value: 'first_exist_fallback', label: 'First that exists, else the last' },
					{ value: 'smallest_size', label: 'Smallest file' },
					{ value: 'largest_size', label: 'Largest file' },
					{ value: 'most_recently_modified', label: 'Most recently modified' }
				]
			})
		],
		claims: ['policy']
	};
}

export function importForm(schema: SchemaBundle | null): FormSpec {
	const pattern: TextField = {
		kind: 'text',
		id: 'pattern',
		label: 'Snippet or file',
		type: 'path',
		required: true,
		placeholder: 'tinyauth_forwarder',
		help: 'A snippet name from this file, or a file path or glob such as sites-enabled/*.',
		placeholders: false,
		get: (n) => getArg(n, 0),
		set: (n, v) => setArg(n, 0, v === '' ? undefined : v)
	};
	return {
		name: 'import',
		title: 'Import',
		summary: 'Paste a snippet or another file in here.',
		docsUrl: docsUrlOf(schema, 'import'),
		fields: [
			pattern,
			argList(1, {
				label: 'Arguments',
				type: 'string',
				help: 'Available inside the snippet as {args[0]}, {args[1]}, … and {args[:]}.'
			}),
			note(
				'A block after the import fills the snippet’s {block} or {blocks.name} slots; its lines appear as children in the tree.',
				{
					when: (n: Directive) => n.body !== undefined
				}
			)
		],
		claims: []
	};
}

registerForm('redir', redirForm);
registerForm('rewrite', rewriteForm);
registerForm('try_files', tryFilesForm);
registerForm('import', importForm);
