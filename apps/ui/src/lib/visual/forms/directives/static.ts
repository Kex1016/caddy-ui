/**
 * Static sites and templates: `root`, `fs`, `templates`, `php_fastcgi`.
 */
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { arg, claimsOf, flag, note, rows, section, subList, subText } from '../fields';
import { subs } from '../node';
import { registerForm } from '../registry';
import type { FieldSpec, FormSpec } from '../types';
import { subArg } from './helpers';
import { reverseProxyForm } from './reverse-proxy';
import { docsUrlOf } from './schema-fields';
import { upstreamsField } from './upstreams';

export function rootForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'root',
		title: 'Site root',
		summary: 'The folder that file_server, try_files, templates and php_fastcgi read from.',
		docsUrl: docsUrlOf(schema, 'root'),
		fields: [
			arg(0, {
				id: 'path',
				label: 'Folder',
				type: 'path',
				required: true,
				placeholder: '/srv/www',
				help: 'A path inside the Caddy container. Relative paths start at Caddy’s working directory. Placeholders work, such as /srv/{host}.'
			})
		],
		claims: []
	};
}

export function fsForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'fs',
		title: 'File system',
		summary: 'Read files from a named file system instead of the disk.',
		docsUrl: docsUrlOf(schema, 'fs'),
		fields: [
			arg(0, {
				id: 'filesystem',
				label: 'File system',
				required: true,
				placeholder: 'foo',
				placeholders: false,
				help: 'A name set up with the global filesystem option (usually a plugin, such as an S3 bucket).'
			})
		],
		claims: []
	};
}

export function templatesForm(schema: SchemaBundle | null): FormSpec {
	return {
		name: 'templates',
		title: 'Templates',
		summary: 'Run responses through Go templates ({{.Host}}, {{include "x"}}, …).',
		docsUrl: docsUrlOf(schema, 'templates'),
		fields: [
			subList('mime', {
				label: 'Content types',
				placeholder: 'text/html',
				help: 'Only these responses are templated. Default: text/html and text/plain.'
			}),
			subArg('between', 0, { label: 'Opening delimiter', placeholder: '{{', placeholders: false }),
			subArg('between', 1, {
				label: 'Closing delimiter',
				placeholder: '}}',
				placeholders: false,
				when: (n) => subs(n, 'between').length > 0
			}),
			subText('root', {
				label: 'Root for include',
				type: 'path',
				placeholder: '/srv/templates',
				help: 'Where {{include}} and {{readFile}} look. Default: the site root.'
			}),
			note(
				'Template extensions (plugins such as a hit counter) are kept as written; edit them in the text view.',
				{
					when: (n) => subs(n, 'extensions').length > 0
				}
			)
		],
		claims: ['mime', 'between', 'root']
	};
}

const PHP = ['php_fastcgi'] as const;

export function phpFastcgiForm(schema: SchemaBundle | null): FormSpec {
	// php_fastcgi is reverse_proxy with a FastCGI transport and presets: borrow its sections except the
	// transport, which php_fastcgi sets itself.
	const proxy = reverseProxyForm(schema).fields.filter(
		(f) => f.kind === 'section' && f.id !== 'section:transport'
	);
	const fields: FieldSpec[] = [
		upstreamsField({
			label: 'PHP-FPM',
			help: 'Where PHP-FPM listens: 127.0.0.1:9000, a container such as app:9000, or unix//run/php/php-fpm.sock.'
		}),
		section('PHP', [
			subText('root', {
				label: 'Root inside PHP-FPM',
				type: 'path',
				placeholder: '/var/www/html/public',
				help: 'When PHP-FPM runs in another container and sees the files under a different path. Default: the site root.'
			}),
			subList('split', { label: 'Split path at', placeholder: '.php', help: 'Default: .php' }),
			subList('index', {
				label: 'Index file',
				type: 'path',
				placeholder: 'index.php',
				literals: ['off'],
				help: 'Requests that match no file go here. off disables the rewrite. Default: index.php.'
			}),
			subList('try_files', {
				label: 'Try files',
				type: 'path',
				placeholder: '{path}',
				help: 'Replaces the default {path} {path}/index.php index.php; end with =404 to stop there.'
			}),
			rows('env', {
				label: 'Environment variables',
				columns: [
					{ id: 'key', label: 'Variable', type: 'string', placeholder: 'APP_ENV' },
					{ id: 'value', label: 'Value', type: 'string', optional: true, placeholder: 'production' }
				],
				addLabel: 'Add variable'
			}),
			flag('resolve_root_symlink', {
				label: 'Resolve the root if it is a symlink',
				help: 'For zero-downtime deploys that swap a current symlink.'
			}),
			flag('capture_stderr', {
				label: 'Log PHP-FPM errors',
				help: 'Logs what PHP writes to stderr, even on success.'
			})
		]),
		section(
			'FastCGI timeouts',
			[
				subText('dial_timeout', { label: 'Connect timeout', type: 'duration', placeholder: '3s' }),
				subText('read_timeout', { label: 'Read timeout', type: 'duration' }),
				subText('write_timeout', { label: 'Write timeout', type: 'duration' })
			],
			{ collapsed: true }
		),
		...proxy.map((f) => (f.kind === 'section' ? { ...f, collapsed: true } : f))
	];
	return {
		name: 'php_fastcgi',
		title: 'PHP (FastCGI)',
		summary: 'Serve a PHP site through PHP-FPM.',
		docsUrl: docsUrlOf(schema, PHP[0]),
		fields,
		claims: [...claimsOf(fields), 'to', 'handle_response', 'header_up', 'header_down']
	};
}

registerForm('root', rootForm);
registerForm('fs', fsForm);
registerForm('templates', templatesForm);
registerForm('php_fastcgi', phpFastcgiForm);
