/**
 * Recipes: short forms that produce a canonical site block (or snippet), used by "Add site" on the
 * Sites page and by the visual editor's add menu. Pure functions so the Sites page can render them on
 * the server with the same code. Each recipe lists its fields; `renderRecipe` returns Caddyfile text.
 */

export type RecipeField = {
	id: string;
	label: string;
	placeholder?: string;
	help?: string;
	required?: boolean;
	/** `select` renders a dropdown; `toggle` a checkbox (value "on"). */
	kind?: 'text' | 'select' | 'toggle';
	options?: { value: string; label: string }[];
	default?: string;
};

export type Recipe = {
	id: string;
	title: string;
	line: string;
	/** `site` recipes need addresses; `snippet` ones a name. */
	kind: 'site' | 'snippet';
	fields: RecipeField[];
	/** Body lines of the block (without the braces), one string per line; nested lines carry their own tabs. */
	body: (v: Record<string, string>) => string[];
};

export class RecipeError extends Error {
	constructor(
		readonly field: string,
		message: string
	) {
		super(message);
		this.name = 'RecipeError';
	}
}

const token = (v: Record<string, string>, id: string, what: string, required = true): string => {
	const t = (v[id] ?? '').trim();
	if (t === '') {
		if (required) throw new RecipeError(id, `Enter ${what}.`);
		return '';
	}
	if (/[\s"`{}#]/.test(t.replace(/\{[$]?[A-Za-z0-9_.:-]+\}/g, '')))
		throw new RecipeError(
			id,
			`${what[0]!.toUpperCase()}${what.slice(1)} cannot contain spaces, quotes or braces.`
		);
	return t;
};

const on = (v: Record<string, string>, id: string) => v[id] === 'on' || v[id] === 'true' || v[id] === '1';

const authFields: RecipeField[] = [
	{
		id: 'auth',
		label: 'Auth service',
		placeholder: '10.0.0.101:8888',
		required: true,
		help: 'The forward_auth upstream; for tinyauth the host and port of the tinyauth container.'
	},
	{
		id: 'authUri',
		label: 'Auth URI',
		placeholder: '/api/auth/caddy',
		default: '/api/auth/caddy',
		required: true
	},
	{
		id: 'copyHeaders',
		label: 'Headers to copy',
		placeholder: 'Remote-User Remote-Name Remote-Email Remote-Groups',
		default: 'Remote-User Remote-Name Remote-Email Remote-Groups',
		help: 'Space-separated; passed on to the app when the auth service says yes.'
	}
];

function forwardAuthLines(v: Record<string, string>, indent = ''): string[] {
	const auth = token(v, 'auth', 'the auth service address');
	const uri = token(v, 'authUri', 'the auth URI');
	const headers = (v.copyHeaders ?? '')
		.split(/[\s,]+/)
		.map((h) => h.trim())
		.filter(Boolean);
	return [
		`${indent}forward_auth ${auth} {`,
		`${indent}\turi ${uri}`,
		...(headers.length ? [`${indent}\tcopy_headers ${headers.join(' ')}`] : []),
		`${indent}}`
	];
}

export const RECIPES: Recipe[] = [
	{
		id: 'reverse_proxy',
		title: 'Reverse proxy',
		line: 'Send everything to one backend. Most sites are this.',
		kind: 'site',
		fields: [
			{
				id: 'upstream',
				label: 'Upstream',
				placeholder: '10.0.0.10:8080',
				required: true,
				help: 'host:port, or https://host for a TLS backend.'
			},
			{ id: 'websocket', label: 'Pass Upgrade headers (WebSocket apps, consoles)', kind: 'toggle' }
		],
		body: (v) => {
			const up = token(v, 'upstream', 'an upstream address');
			if (!on(v, 'websocket')) return [`reverse_proxy ${up}`];
			return [
				`reverse_proxy ${up} {`,
				'\theader_up Upgrade {http.request.header.Upgrade}',
				'\theader_up Connection {http.request.header.Connection}',
				'}'
			];
		}
	},
	{
		id: 'redirect',
		title: 'Redirect to another site',
		line: 'Send visitors elsewhere, keeping the path.',
		kind: 'site',
		fields: [
			{ id: 'target', label: 'Send visitors to', placeholder: 'https://example.com', required: true },
			{ id: 'keepPath', label: 'Keep the path and query ({uri})', kind: 'toggle', default: 'on' },
			{
				id: 'code',
				label: 'Kind',
				kind: 'select',
				default: 'permanent',
				options: [
					{ value: 'permanent', label: 'Permanent (301)' },
					{ value: 'temporary', label: 'Temporary (302)' },
					{ value: '308', label: 'Permanent, keep the method (308)' }
				]
			}
		],
		body: (v) => {
			const target = token(v, 'target', 'a URL');
			const code = v.code === 'temporary' ? '' : ` ${v.code || 'permanent'}`;
			return [`redir ${target}${on(v, 'keepPath') ? '{uri}' : ''}${code}`];
		}
	},
	{
		id: 'static',
		title: 'Static site',
		line: 'Serve files from a folder.',
		kind: 'site',
		fields: [
			{ id: 'root', label: 'Folder', placeholder: '/srv/www', required: true },
			{ id: 'browse', label: 'Show directory listings', kind: 'toggle' },
			{ id: 'spa', label: 'Single-page app (send unknown paths to index.html)', kind: 'toggle' },
			{ id: 'encode', label: 'Compress responses (zstd, gzip)', kind: 'toggle', default: 'on' }
		],
		body: (v) => {
			const root = token(v, 'root', 'a folder');
			return [
				`root * ${root}`,
				...(on(v, 'encode') ? ['encode zstd gzip'] : []),
				...(on(v, 'spa') ? ['try_files {path} /index.html'] : []),
				on(v, 'browse') ? 'file_server browse' : 'file_server'
			];
		}
	},
	{
		id: 'php',
		title: 'PHP site',
		line: 'Static files plus PHP through php-fpm.',
		kind: 'site',
		fields: [
			{ id: 'root', label: 'Folder', placeholder: '/srv/www', required: true },
			{
				id: 'fpm',
				label: 'php-fpm',
				placeholder: 'php:9000',
				required: true,
				help: 'host:port or unix//run/php/php-fpm.sock'
			}
		],
		body: (v) => [
			`root * ${token(v, 'root', 'a folder')}`,
			`php_fastcgi ${token(v, 'fpm', 'the php-fpm address')}`,
			'file_server'
		]
	},
	{
		id: 'protected',
		title: 'Protected by tinyauth',
		line: 'A reverse proxy behind forward_auth, like the other protected sites.',
		kind: 'site',
		fields: [
			{ id: 'upstream', label: 'Upstream', placeholder: '10.0.0.10:8080', required: true },
			...authFields,
			{
				id: 'snippet',
				label: 'Import an existing snippet instead',
				placeholder: 'tinyauth_forwarder',
				help: 'If the file has a forward_auth snippet, name it here and the auth fields above are ignored.'
			}
		],
		body: (v) => {
			const up = token(v, 'upstream', 'an upstream address');
			const snippet = token(v, 'snippet', 'a snippet name', false);
			return [...(snippet ? [`import ${snippet}`] : forwardAuthLines(v)), `reverse_proxy ${up}`];
		}
	},
	{
		id: 'error_page',
		title: 'Proxy with a custom error page',
		line: 'A reverse proxy; when it fails, a static page is served instead.',
		kind: 'site',
		fields: [
			{ id: 'upstream', label: 'Upstream', placeholder: '10.0.0.10:8080', required: true },
			{
				id: 'page',
				label: 'Error page',
				placeholder: '/usr/share/caddy/invalid_site/index.html',
				required: true,
				help: 'A file inside the Caddy container.'
			}
		],
		body: (v) => {
			const up = token(v, 'upstream', 'an upstream address');
			const page = token(v, 'page', 'the error page path');
			return [
				'handle {',
				`\treverse_proxy ${up}`,
				'}',
				'handle_errors {',
				`\ttry_files {path} ${page}`,
				'\tfile_server',
				'}'
			];
		}
	},
	{
		id: 'snippet',
		title: 'Just a snippet',
		line: 'A reusable block that sites pull in with import.',
		kind: 'snippet',
		fields: [{ id: 'name', label: 'Snippet name', placeholder: 'common_headers', required: true }],
		body: () => []
	},
	{
		id: 'blank',
		title: 'Blank block',
		line: 'An empty site block to fill in the editor.',
		kind: 'site',
		fields: [],
		body: () => []
	}
];

export function recipeById(id: string): Recipe | undefined {
	return RECIPES.find((r) => r.id === id);
}

/** The default values of a recipe's fields, for a fresh form. */
export function recipeDefaults(recipe: Recipe): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of recipe.fields) if (f.default !== undefined) out[f.id] = f.default;
	return out;
}

/** The block text, indented with tabs as caddy fmt writes it. */
export function renderRecipe(
	recipe: Recipe,
	header: { addresses?: string[]; name?: string },
	values: Record<string, string>,
	eol = '\n'
): string {
	const v = { ...recipeDefaults(recipe), ...values };
	const body = recipe.body(v);
	let head: string;
	if (recipe.kind === 'snippet') {
		const name = token({ name: header.name ?? v.name ?? '' }, 'name', 'a snippet name').replace(
			/^\(|\)$/g,
			''
		);
		if (!/^[A-Za-z0-9_.-]+$/.test(name))
			throw new RecipeError('name', 'Snippet names use letters, digits, _ . and -.');
		head = `(${name})`;
	} else {
		const addresses = header.addresses ?? [];
		if (!addresses.length)
			throw new RecipeError('addresses', 'Enter at least one address, such as app.example.com.');
		head = addresses.join(', ');
	}
	return [`${head} {`, ...body.map((l) => `\t${l}`), '}'].join(eol);
}
