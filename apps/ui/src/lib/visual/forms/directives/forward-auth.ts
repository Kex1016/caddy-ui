import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { createDirective, type Directive } from '@caddy-ui/caddyfile';
import { claimsOf, rows, section, subText } from '../fields';
import { setSub, sub, subs } from '../node';
import { registerForm } from '../registry';
import type { FieldSpec, FormSpec, ListField } from '../types';
import { proxyTuningSections } from './reverse-proxy';
import { docsUrlOf } from './schema-fields';
import { upstreamsField } from './upstreams';

/** `copy_headers A B C` on one line, or one header per line in a block; `Old>New` renames. */
function copyHeadersField(): ListField {
	return {
		kind: 'list',
		id: 'copy_headers',
		label: 'Headers to copy from the auth response',
		help: 'Copied onto the original request when the auth service answers 2xx. Remote-User>X-User renames.',
		type: 'header',
		placeholder: 'Remote-User',
		get: (n: Directive) => {
			const line = sub(n, 'copy_headers');
			if (!line) return [];
			const inline = line.args.map((a) => a.text);
			const block = (line.body ?? [])
				.filter((x): x is Directive => x.kind === 'directive')
				.map((x) => [x.name.text, ...x.args.map((a) => a.text)].join(' '));
			return [...inline, ...block];
		},
		set: (n, values) => {
			const line = sub(n, 'copy_headers');
			if (line?.body) {
				// keep the block form: one header per line
				line.body = values.map((v) => {
					const [name = '', ...rest] = v.split(/\s+/);
					return createDirective(name, rest);
				});
				line.args = [];
				if (!values.length) setSub(n, 'copy_headers', undefined);
				return;
			}
			setSub(n, 'copy_headers', values.length ? values : undefined);
		}
	};
}

export function forwardAuthForm(schema: SchemaBundle | null): FormSpec {
	const fields: FieldSpec[] = [
		upstreamsField({
			label: 'Auth service',
			help: 'Where the auth request goes, e.g. 10.0.0.101:8888 for tinyauth.'
		}),
		subText('uri', {
			label: 'Auth URI',
			type: 'path',
			placeholder: '/api/auth/caddy',
			help: 'The path (and query) the auth service checks.'
		}),
		copyHeadersField(),
		section('Headers sent to the auth service', [
			rows('header_up', {
				label: 'Request headers',
				help: 'Caddy already sends X-Forwarded-Method, -Uri, -Host and -For.',
				columns: [
					{ id: 'field', label: 'Header', type: 'header', prefixes: ['+', '-', '>'] },
					{ id: 'value', label: 'Value', type: 'string', optional: true },
					{ id: 'replacement', label: 'Replace with', type: 'string', optional: true }
				],
				addLabel: 'Add header'
			})
		]),
		...proxyTuningSections(schema)
	];
	return {
		name: 'forward_auth',
		title: 'Forward auth',
		summary: 'Ask an auth service (tinyauth, Authelia, …) before serving the request.',
		docsUrl: docsUrlOf(schema, 'forward_auth'),
		fields,
		claims: [...claimsOf(fields), 'to', 'uri', 'copy_headers', 'handle_response', 'header_up'],
		describe: (n) => {
			const to = [...n.args.map((a) => a.text), ...subs(n, 'to').flatMap((s) => s.args.map((a) => a.text))];
			const uri = sub(n, 'uri')?.args[0]?.text;
			return ['→', ...to, uri ?? ''].join(' ').trim();
		}
	};
}

registerForm('forward_auth', forwardAuthForm);
