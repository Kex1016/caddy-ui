/**
 * `handle`, `route`, `handle_errors` and `handle_path`: their bodies are directives, shown as children
 * in the tree, so the forms only carry the header arguments and a note on how the block behaves.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { arg, argList, note } from '../fields';
import { registerForm } from '../registry';
import type { FormSpec } from '../types';
import { docsUrlOf } from './schema-fields';

export function handleForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'handle',
		title: 'Handle',
		summary: 'A group of directives; only the first handle block whose matcher matches runs.',
		docsUrl: docsUrlOf(schema, 'handle'),
		container: true,
		fields: [
			note(
				'Handle blocks are mutually exclusive: for each request only the first matching one runs, and a handle with no matcher is the fallback. Directives inside appear as children in the tree; add them there.'
			)
		],
		claims: []
	};
}

export function routeForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'route',
		title: 'Route',
		summary: 'Directives run in exactly the order written, not Caddy’s default order.',
		docsUrl: docsUrlOf(schema, 'route'),
		container: true,
		fields: [
			note(
				'Inside a route the file order is the run order, so put forward_auth or uri before reverse_proxy. Directives inside appear as children in the tree.'
			)
		],
		claims: []
	};
}

export function handleErrorsForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'handle_errors',
		title: 'Handle errors',
		summary: 'What to serve when a handler returns an error (404, 502, …).',
		docsUrl: docsUrlOf(schema, 'handle_errors'),
		container: true,
		fields: [
			argList(0, {
				label: 'Only for these status codes',
				help: 'Leave empty to handle every error. 4xx and 5xx match a whole range.',
				type: 'status',
				placeholder: '404'
			}),
			note(
				'Inside, {err.status_code} and {err.message} are available. A typical block rewrites to a static page with try_files and file_server; add those as children in the tree.'
			)
		],
		claims: []
	};
}

export function handlePathForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'handle_path',
		title: 'Handle path',
		summary: 'Like handle, but strips the matched prefix from the path first.',
		docsUrl: docsUrlOf(schema, 'handle_path'),
		container: true,
		fields: [
			arg(0, {
				label: 'Path prefix',
				type: 'path',
				required: true,
				placeholder: '/api/*',
				help: 'Must end in * to strip a prefix: /api/* turns /api/users into /users for the directives inside.'
			})
		],
		claims: []
	};
}

registerForm('handle', handleForm);
registerForm('route', routeForm);
registerForm('handle_errors', handleErrorsForm);
registerForm('handle_path', handlePathForm);
