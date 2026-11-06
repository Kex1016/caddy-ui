import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import type { Directive } from '@caddy-ui/caddyfile';
import { claimsOf, flag, group, section, subList, subText } from '../fields';
import { getArg, setArgsFrom, sub } from '../node';
import { registerForm } from '../registry';
import type { FieldSpec, FormSpec, TextField, ToggleField } from '../types';
import { docsUrlOf, schemaFields } from './schema-fields';

/** `file_server browse`: the only positional argument is the `browse` keyword. */
const browseArg: ToggleField = {
	kind: 'toggle',
	id: 'browse-arg',
	label: 'Show directory listings',
	help: 'Lists the files of a folder that has no index file (the `browse` keyword).',
	get: (n: Directive) => getArg(n, 0) === 'browse' || sub(n, 'browse') !== undefined,
	set: (n, on) => {
		if (on) {
			if (getArg(n, 0) !== 'browse' && !sub(n, 'browse')) setArgsFrom(n, 0, ['browse']);
		} else {
			if (getArg(n, 0) === 'browse') setArgsFrom(n, 0, []);
			if (sub(n, 'browse'))
				n.body = (n.body ?? []).filter((x) => !(x.kind === 'directive' && x.name.text === 'browse'));
		}
	}
};

/** `browse [<template_file>]`: the template is the block's own argument. */
const templateField: TextField = {
	kind: 'text',
	id: 'template',
	label: 'Template file',
	type: 'path',
	help: 'A Go template for the listing page; Caddy’s built-in one is used when empty.',
	get: (n) => getArg(n, 0),
	set: (n, v) => setArgsFrom(n, 0, v ? [v] : [])
};

export function fileServerForm(schema: SchemaBundle | null): FormSpec {
	const fields: FieldSpec[] = [
		subText('root', {
			label: 'Folder',
			type: 'path',
			placeholder: '/srv/www',
			help: 'Where the files are. Leave empty to use the site’s root directive (or the current directory).'
		}),
		browseArg,
		subList('index', {
			label: 'Index files',
			type: 'path',
			placeholder: 'index.html',
			help: 'Tried in order for a folder. Default: index.html index.txt.'
		}),
		subList('hide', {
			label: 'Hide',
			type: 'path',
			placeholder: '.git',
			help: 'Files and folders that answer 404 even if they exist.'
		}),
		subList('precompressed', {
			label: 'Serve precompressed sidecars',
			type: 'string',
			choices: [
				{ value: 'zstd', label: 'zstd (.zst)' },
				{ value: 'br', label: 'brotli (.br)' },
				{ value: 'gzip', label: 'gzip (.gz)' }
			]
		}),
		section(
			'More',
			[
				subText('status', {
					label: 'Status code',
					type: 'status',
					help: 'Answer with this status instead of 200; 404 for a custom error page.'
				}),
				flag('pass_thru', {
					label: 'Pass through when the file is missing',
					help: 'Lets a later handler answer instead of a 404.'
				}),
				flag('disable_canonical_uris', {
					label: 'Do not redirect to canonical URIs',
					help: 'Keeps /dir from redirecting to /dir/.'
				}),
				...schemaFields(schema, ['file_server'], [['fs', { label: 'File system' }]]),
				group('browse', {
					label: 'Listing options',
					collapsed: true,
					fields: [
						templateField,
						...schemaFields(
							schema,
							['file_server', 'browse'],
							[
								['reveal_symlinks', { label: 'Reveal symlink targets' }],
								['sort', { label: 'Sort by' }],
								['file_limit', { label: 'File limit' }]
							]
						)
					]
				})
			],
			{ collapsed: true }
		)
	];
	return {
		name: 'file_server',
		title: 'File server',
		summary: 'Serve static files from a folder.',
		docsUrl: docsUrlOf(schema, 'file_server'),
		fields,
		claims: claimsOf(fields)
	};
}

registerForm('file_server', fileServerForm);
