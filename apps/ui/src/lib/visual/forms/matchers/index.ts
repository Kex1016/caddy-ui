/**
 * Bespoke forms for the matcher modules David's Caddyfile uses (`path`, `path_regexp`) and the two the
 * builder needs special handling for (`expression`, `not`). The named, path-token and wildcard forms are
 * the directive's matcher slot, handled by `MatcherSlot.svelte`. The other 13 modules get generic
 * schema forms until W5b replaces them.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import type { Directive } from '@caddy-ui/caddyfile';
import { argList, note } from '../fields';
import { getArg, replaceArgs as setArgs } from '../node';
import { registerMatcherForm } from '../registry';
import type { FormSpec, TextField } from '../types';

const matcherDocs = (schema: SchemaBundle | null, name: string) =>
	schema?.matchers[name]?.docsUrl ??
	`https://caddyserver.com/docs/caddyfile/matchers#${name.replace(/_/g, '-')}`;

export function pathMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'path',
		title: 'Path',
		summary: 'Matches the request path. Any of the paths matches (OR).',
		docsUrl: matcherDocs(schema, 'path'),
		fields: [
			argList(0, {
				label: 'Paths',
				type: 'path',
				placeholder: '/admin*',
				help: 'Exact unless it has *: /edit* matches /edit and /editor, /img/* matches everything under /img/. Case-insensitive.'
			})
		],
		claims: []
	};
}

/** `path_regexp [<name>] <regexp>`: an optional capture name before the pattern. */
export function pathRegexpMatcherForm(schema: SchemaBundle | null): FormSpec {
	const hasName = (n: Directive) => n.args.length >= 2;
	const name: TextField = {
		kind: 'text',
		id: 'name',
		label: 'Capture name',
		type: 'string',
		placeholder: 'optional',
		help: 'Captures become {re.name.1}, {re.name.2}, … (or {re.1} without a name).',
		placeholders: false,
		get: (n) => (hasName(n) ? getArg(n, 0) : undefined),
		set: (n, v) => {
			const re = hasName(n) ? getArg(n, 1) : getArg(n, 0);
			setArgs(n, v ? [v, re ?? ''] : re !== undefined ? [re] : []);
		}
	};
	const regexp: TextField = {
		kind: 'text',
		id: 'regexp',
		label: 'Regular expression',
		type: 'regexp',
		required: true,
		placeholder: '^/u/([^/]+)(.*)$',
		placeholders: false,
		get: (n) => (hasName(n) ? getArg(n, 1) : getArg(n, 0)),
		set: (n, v) => {
			const nm = hasName(n) ? getArg(n, 0) : undefined;
			setArgs(n, nm ? [nm, v ?? ''] : v !== undefined ? [v] : []);
		}
	};
	return {
		name: 'path_regexp',
		title: 'Path regexp',
		summary: 'Matches the path against a Go regular expression and captures parts of it.',
		docsUrl: matcherDocs(schema, 'path_regexp'),
		fields: [regexp, name],
		claims: []
	};
}

export function expressionMatcherForm(schema: SchemaBundle | null): FormSpec {
	const expr: TextField = {
		kind: 'text',
		id: 'expression',
		label: 'CEL expression',
		type: 'cel',
		required: true,
		multiline: true,
		placeholder: '{method} == "GET" && {path}.startsWith("/api/")',
		help: 'Placeholders work as {name}; other matchers are functions: path("/a*"), host("x.com"), header({"X": "y"}).',
		get: (n) => n.args.map((a) => a.text).join(' '),
		set: (n, v) => setArgs(n, v ? [v] : [])
	};
	return {
		name: 'expression',
		title: 'Expression',
		summary: 'A CEL expression that must be true.',
		docsUrl: matcherDocs(schema, 'expression'),
		fields: [expr],
		claims: []
	};
}

export function notMatcherForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'not',
		title: 'Not',
		summary: 'Negates the matchers inside.',
		docsUrl: matcherDocs(schema, 'not'),
		fields: [note('The matchers to negate are edited as nested rows in the matcher builder, or as text.')],
		claims: []
	};
}

registerMatcherForm('path', pathMatcherForm);
registerMatcherForm('path_regexp', pathRegexpMatcherForm);
registerMatcherForm('expression', expressionMatcherForm);
registerMatcherForm('not', notMatcherForm);
