/**
 * `uri strip_prefix|strip_suffix|replace|path_regexp|query …`: the first argument picks the operation
 * and the rest depend on it. `uri query { … }` holds one operation per line.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import type { Directive } from '@caddy-ui/caddyfile';
import { arg, argSelect, freeformRows, note } from '../fields';
import { getArg } from '../node';
import { registerForm } from '../registry';
import type { FieldSpec, FormSpec } from '../types';
import { docsUrlOf } from './schema-fields';

const op = (n: Directive) => getArg(n, 0);

export function uriForm(schema: SchemaBundle | null): FormSpec {
	const fields: FieldSpec[] = [
		argSelect(0, {
			label: 'Operation',
			options: [
				{ value: 'strip_prefix', label: 'Strip a path prefix' },
				{ value: 'strip_suffix', label: 'Strip a path suffix' },
				{ value: 'replace', label: 'Replace text in the URI' },
				{ value: 'path_regexp', label: 'Replace in the path with a regexp' },
				{ value: 'query', label: 'Change the query string' }
			]
		}),
		arg(1, {
			id: 'prefix',
			label: 'Prefix to strip',
			type: 'path',
			required: true,
			placeholder: '/api',
			help: '/api/users becomes /users. The matcher usually keeps the directive to that prefix.',
			when: (n) => op(n) === 'strip_prefix'
		}),
		arg(1, {
			id: 'suffix',
			label: 'Suffix to strip',
			type: 'path',
			required: true,
			placeholder: '.php',
			when: (n) => op(n) === 'strip_suffix'
		}),
		arg(1, {
			id: 'find',
			label: 'Find',
			required: true,
			placeholder: '/docs/',
			when: (n) => op(n) === 'replace'
		}),
		arg(2, {
			id: 'replace-with',
			label: 'Replace with',
			required: true,
			placeholder: '/v1/docs/',
			when: (n) => op(n) === 'replace'
		}),
		arg(3, {
			id: 'limit',
			label: 'At most',
			type: 'int',
			placeholder: 'all',
			help: 'How many occurrences to replace; empty means all.',
			when: (n) => op(n) === 'replace'
		}),
		arg(1, {
			id: 'regexp',
			label: 'Regexp to find in the path',
			type: 'regexp',
			required: true,
			placeholder: '/{2,}',
			when: (n) => op(n) === 'path_regexp'
		}),
		arg(2, {
			id: 'regexp-replace',
			label: 'Replace with',
			required: true,
			placeholder: '/',
			help: '$1, $2 insert capture groups.',
			when: (n) => op(n) === 'path_regexp'
		}),
		arg(1, {
			id: 'param',
			label: 'Parameter',
			placeholder: 'page',
			help: 'Set it with a value, +name adds another value, -name deletes it, old>new renames it.',
			when: (n) => op(n) === 'query' && n.body === undefined
		}),
		arg(2, {
			id: 'value',
			label: 'Value',
			placeholder: '1',
			help: 'With a regexp here and a replacement below, the value is rewritten.',
			when: (n) => op(n) === 'query' && n.body === undefined
		}),
		arg(3, {
			id: 'replacement',
			label: 'Replacement',
			when: (n) => op(n) === 'query' && n.body === undefined
		}),
		freeformRows({
			id: 'query-rows',
			label: 'Query operations',
			help: 'One per line: name value sets, +name value adds, -name deletes, old>new renames, name regexp replacement rewrites.',
			columns: [
				{ id: 'param', label: 'Parameter', type: 'string', placeholder: '+page' },
				{ id: 'value', label: 'Value', type: 'string', optional: true },
				{ id: 'replacement', label: 'Replacement', type: 'string', optional: true }
			],
			addLabel: 'Add operation',
			when: (n) => op(n) === 'query' && n.body !== undefined
		}),
		note('Several query operations can go in one block: edit this line as text and give it a { } body.', {
			when: (n) => op(n) === 'query' && n.body === undefined
		})
	];
	return {
		name: 'uri',
		title: 'URI',
		summary: 'Strip, replace or rewrite parts of the request URI.',
		docsUrl: docsUrlOf(schema, 'uri'),
		fields,
		claims: [],
		// `uri query { … }`: every line is a query operation row
		claimsAllLines: (n) => op(n) === 'query'
	};
}

registerForm('uri', uriForm);
