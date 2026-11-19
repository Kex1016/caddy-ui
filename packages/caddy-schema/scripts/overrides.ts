/**
 * Hand-curated corrections on top of what the generator extracts from the docs.
 *
 * The generator gets names, nesting, docs and most value types right from the
 * syntax skeletons. What it cannot know is written here: categories, enums the docs
 * state in prose, argument lists the docs write as alternatives (`tls`, `uri`), and
 * which `[<matcher>]` tokens mean a *response* matcher. Every entry addresses a node
 * by path, so a docs change that moves a node makes `applyOverrides` throw instead of
 * silently doing nothing.
 */
import type {
	ArgSchema,
	DirectiveCategory,
	DirectiveSchema,
	MatcherSchema,
	MatcherTokenForm,
	PlaceholderSchema,
	SchemaBundle
} from '../src/types.ts';

const SITE = 'https://caddyserver.com';

export const CATEGORIES: Record<string, DirectiveCategory> = {
	// grouping and dispatch
	handle: 'routing',
	handle_errors: 'routing',
	handle_path: 'routing',
	route: 'routing',
	invoke: 'routing',
	// request manipulation and context
	fs: 'request',
	map: 'request',
	method: 'request',
	request_body: 'request',
	request_header: 'request',
	rewrite: 'request',
	root: 'request',
	try_files: 'request',
	uri: 'request',
	vars: 'request',
	// response manipulation
	encode: 'response',
	header: 'response',
	intercept: 'response',
	push: 'response',
	redir: 'response',
	templates: 'response',
	// wrapping middleware
	basic_auth: 'middleware',
	forward_auth: 'middleware',
	timeouts: 'middleware',
	tracing: 'middleware',
	// terminal handlers
	abort: 'handler',
	acme_server: 'handler',
	error: 'handler',
	file_server: 'handler',
	metrics: 'handler',
	php_fastcgi: 'handler',
	respond: 'handler',
	reverse_proxy: 'handler',
	// other
	tls: 'tls',
	log: 'logging',
	log_append: 'logging',
	log_level: 'logging',
	log_name: 'logging',
	log_skip: 'logging',
	bind: 'misc',
	import: 'misc'
};

export const MATCHER_TOKEN_FORMS: MatcherTokenForm[] = [
	{
		name: 'wildcard',
		pattern: '*',
		doc: 'Matches all requests. Usually optional: a directive with no matcher token matches every request, but `*` is needed when the first argument is itself a path (e.g. `rewrite * /foo`).',
		docsUrl: `${SITE}/docs/caddyfile/matchers#wildcard-matchers`
	},
	{
		name: 'path',
		pattern: '/<path>',
		doc: 'A token starting with `/` is a path matcher. Paths match exactly unless they end in `*` (prefix) or contain `*` elsewhere; directives with a single path matcher are sorted by specificity.',
		docsUrl: `${SITE}/docs/caddyfile/matchers#path-matchers`
	},
	{
		name: 'named',
		pattern: '@<name>',
		doc: 'Refers to a matcher set defined in the same site block with `@name <matcher> …`, `@name { … }`, or the CEL shorthand ``@name `expr` ``. All matchers in a set must match (AND).',
		docsUrl: `${SITE}/docs/caddyfile/matchers#named-matchers`
	}
];

const P = (
	name: string,
	doc: string,
	scope: PlaceholderSchema['scope'],
	extra: Partial<PlaceholderSchema> = {}
): PlaceholderSchema => ({
	name,
	doc,
	scope,
	...(/\*|\bN\b|<|\[N\]|\[:\]/.test(name) ? { parameterized: true } : {}),
	...extra
});

/**
 * Placeholders the Caddyfile docs mention only in passing or not at all (they live in
 * the generated JSON docs, which are not markdown). Long forms of the shorthands come
 * from concepts.md automatically.
 */
export const EXTRA_PLACEHOLDERS: PlaceholderSchema[] = [
	P('{http.request.body}', 'The request body (reads the whole body into memory; use with care).', 'http'),
	P('{http.request.body_base64}', 'The request body, base64-encoded.', 'http'),
	P('{http.request.duration}', 'Time elapsed since the request started, as a duration.', 'http'),
	P('{http.request.duration_ms}', 'Time elapsed since the request started, in milliseconds.', 'http'),
	P('{http.request.local}', 'The local address the connection came in on.', 'http'),
	P('{http.request.local.host}', 'The host of the local address.', 'http'),
	P('{http.request.local.port}', 'The port of the local address.', 'http'),
	P('{http.request.proto}', 'The request protocol, e.g. HTTP/1.1 or HTTP/2.0.', 'http'),
	P('{http.request.uuid}', 'A unique identifier for the request.', 'http'),
	P('{http.request.uri.path.N}', 'The Nth segment of the request path (0-based).', 'http', {
		shorthand: '{path.N}'
	}),
	P(
		'{path.N}',
		'The Nth segment of the request path (0-based). Shorthand for {http.request.uri.path.N}.',
		'http',
		{ longForm: '{http.request.uri.path.N}' }
	),
	P(
		'{http.request.host.labels.N}',
		'The Nth label of the host, counted from the right (0 is the TLD).',
		'http',
		{ shorthand: '{labels.N}' }
	),
	P('{labels.N}', 'The Nth label of the host, counted from the right (0 is the TLD).', 'http', {
		longForm: '{http.request.host.labels.N}'
	}),
	P('{http.request.header.*}', 'A request header field, e.g. {http.request.header.User-Agent}.', 'http', {
		shorthand: '{header.*}'
	}),
	P('{http.request.cookie.*}', 'A request cookie value by name.', 'http', { shorthand: '{cookie.*}' }),
	P('{http.request.uri.query.*}', 'A query parameter value by key.', 'http', { shorthand: '{query.*}' }),
	P(
		'{http.response.header.*}',
		'A response header field (in handlers that run after the response is written, e.g. log fields).',
		'http'
	),
	P('{http.response.status}', 'The response status code (available to logging).', 'http'),
	P('{http.response.size}', 'The number of response body bytes written.', 'http'),
	P('{http.response.latency}', 'Time spent writing the response.', 'http'),
	P('{http.vars.*}', 'A variable set with the vars directive or by a handler.', 'http', {
		shorthand: '{vars.*}'
	}),
	P('{http.regexp.N}', 'Capture group N of the last regexp matcher that ran (unnamed).', 'matcher', {
		shorthand: '{re.N}'
	}),
	P('{re.N}', 'Capture group N of the last unnamed regexp matcher.', 'matcher', {
		longForm: '{http.regexp.N}'
	}),
	P('{http.regexp.name.N}', 'Capture group N of the regexp matcher named `name`.', 'matcher', {
		shorthand: '{re.name.N}'
	}),
	P(
		'{re.name.N}',
		'Capture group N (or a named group) of the regexp matcher named `name`, e.g. {re.static.1} for `@static path_regexp static …`.',
		'matcher',
		{ longForm: '{http.regexp.name.N}' }
	),
	P('{http.error.status_code}', 'The recommended HTTP status code (in handle_errors).', 'error', {
		shorthand: '{err.status_code}'
	}),
	P('{http.error.status_text}', 'The status text for the status code (in handle_errors).', 'error', {
		shorthand: '{err.status_text}'
	}),
	P('{http.error.message}', 'The error message (in handle_errors).', 'error', { shorthand: '{err.message}' }),
	P('{http.error.trace}', 'The origin of the error (in handle_errors).', 'error', {
		shorthand: '{err.trace}'
	}),
	P('{http.error.id}', 'An identifier for this occurrence of the error (in handle_errors).', 'error', {
		shorthand: '{err.id}'
	}),
	P(
		'{http.reverse_proxy.upstream.address}',
		'The full address of the upstream that was selected.',
		'reverse_proxy'
	),
	P('{http.reverse_proxy.upstream.host}', 'The host of the selected upstream.', 'reverse_proxy', {
		shorthand: '{rp.upstream.host}'
	}),
	P('{http.reverse_proxy.upstream.port}', 'The port of the selected upstream.', 'reverse_proxy'),
	P(
		'{http.reverse_proxy.upstream.requests}',
		'Active request count of the selected upstream.',
		'reverse_proxy'
	),
	P(
		'{http.reverse_proxy.upstream.max_requests}',
		'Max request limit of the selected upstream.',
		'reverse_proxy'
	),
	P(
		'{http.reverse_proxy.upstream.fails}',
		'Number of recent failures of the selected upstream.',
		'reverse_proxy'
	),
	P(
		'{http.reverse_proxy.upstream.latency}',
		'Time until the upstream sent response headers.',
		'reverse_proxy',
		{ shorthand: '{rp.upstream.latency}' }
	),
	P('{http.reverse_proxy.upstream.latency_ms}', 'Upstream latency in milliseconds.', 'reverse_proxy', {
		shorthand: '{rp.upstream.latency_ms}'
	}),
	P(
		'{http.reverse_proxy.upstream.duration}',
		'Total time spent proxying to the upstream, including writing the response body.',
		'reverse_proxy',
		{ shorthand: '{rp.upstream.duration}' }
	),
	P(
		'{http.reverse_proxy.upstream.duration_ms}',
		'Total upstream duration in milliseconds.',
		'reverse_proxy',
		{ shorthand: '{rp.upstream.duration_ms}' }
	),
	P(
		'{http.reverse_proxy.duration}',
		'Total time spent proxying, including selecting an upstream and retries.',
		'reverse_proxy'
	),
	P('{http.reverse_proxy.duration_ms}', 'Total proxy time in milliseconds.', 'reverse_proxy'),
	P(
		'{http.reverse_proxy.status_code}',
		'Status code of the upstream response (in handle_response).',
		'reverse_proxy',
		{ shorthand: '{rp.status_code}' }
	),
	P(
		'{http.reverse_proxy.status_text}',
		'Status text of the upstream response (in handle_response).',
		'reverse_proxy',
		{ shorthand: '{rp.status_text}' }
	),
	P(
		'{http.reverse_proxy.header.*}',
		'A header from the upstream response (in handle_response).',
		'reverse_proxy',
		{ shorthand: '{rp.header.*}' }
	),
	P(
		'{http.reverse_proxy.active.target_upstream}',
		'The upstream an active health check is targeting (for health_headers).',
		'reverse_proxy'
	),
	P(
		'{http.reverse_proxy.is_transport_error}',
		'True when the proxy failed because of a transport error.',
		'reverse_proxy',
		{ shorthand: '{rp.is_transport_error}' }
	),
	P(
		'{http.intercept.status_code}',
		'Status code of the intercepted response (in intercept handle_response).',
		'http',
		{ shorthand: '{resp.status_code}' }
	),
	P('{http.intercept.header.*}', 'A header of the intercepted response.', 'http', {
		shorthand: '{resp.header.*}'
	}),
	P(
		'{http.matchers.file.relative}',
		'The path of the file the file matcher found, relative to the root.',
		'matcher',
		{ shorthand: '{file_match.relative}' }
	),
	P('{http.matchers.file.absolute}', 'The absolute path of the file the file matcher found.', 'matcher', {
		shorthand: '{file_match.absolute}'
	}),
	P('{http.matchers.file.type}', 'Whether the file matcher found a file or a directory.', 'matcher', {
		shorthand: '{file_match.type}'
	}),
	P('{http.matchers.file.remainder}', 'The part of the path after the split_path delimiter.', 'matcher', {
		shorthand: '{file_match.remainder}'
	}),
	P('{http.auth.user.id}', 'The authenticated user ID (set by basic_auth).', 'http'),
	P('{http.shutting_down}', 'True while the server is shutting down.', 'http'),
	P('{http.time_until_shutdown}', 'Time left until the server is forcefully shut down.', 'http'),
	P('{args[N]}', 'Argument N (0-based) passed to `import` of a snippet or file.', 'snippet'),
	P(
		'{args[:]}',
		'All arguments passed to `import`, as separate tokens. Slices like {args[1:]} also work.',
		'snippet'
	),
	P(
		'{args[n:m]}',
		'The arguments from index n up to (not including) m, as separate tokens; either bound may be omitted.',
		'snippet'
	),
	P(
		'{block}',
		'The block passed to `import … { … }` (experimental). {blocks.name} inserts a named sub-block.',
		'snippet'
	),
	P('{blocks.*}', 'A named sub-block of the block passed to `import` (experimental).', 'snippet'),
	P(
		'{$VAR}',
		'Caddyfile environment variable, substituted when the Caddyfile is parsed (not a runtime placeholder). `{$VAR:default}` gives a default.',
		'global'
	),
	P('{$VAR:default}', 'Caddyfile environment variable with a default value.', 'global')
];

// ---------------------------------------------------------------------------

type Node = DirectiveSchema | MatcherSchema;

/**
 * Resolve a node path:
 *   d:reverse_proxy/transport/~http/tls_server_name
 *   g:servers/trusted_proxies
 *   m:file   r:status
 * `~name` steps into variants, other steps into subdirectives.
 */
export function resolve(bundle: SchemaBundle, path: string): Node {
	const [kind, rest] = path.split(':');
	const [head, ...steps] = rest.split('/');
	const table =
		kind === 'd'
			? bundle.directives
			: kind === 'g'
				? bundle.globalOptions
				: kind === 'm'
					? bundle.matchers
					: kind === 'r'
						? bundle.responseMatchers
						: undefined;
	let cur: Node | undefined = table?.[head];
	for (const s of steps) {
		if (!cur) break;
		cur = s.startsWith('~')
			? (cur as DirectiveSchema).variants?.[s.slice(1)]
			: (cur as DirectiveSchema).subdirectives?.[s];
	}
	if (!cur) throw new Error(`overrides: no schema node at ${path} (did the docs change?)`);
	return cur;
}

const A = (
	name: string,
	type: ArgSchema['type'],
	doc: string,
	extra: Partial<ArgSchema> = {}
): ArgSchema => ({ name, type, doc, ...extra });

function setArgs(b: SchemaBundle, path: string, args: ArgSchema[]) {
	resolve(b, path).args = args;
}

function patchArg(b: SchemaBundle, path: string, name: string, patch: Partial<ArgSchema>) {
	const node = resolve(b, path);
	const arg = node.args.find((a) => a.name === name);
	if (!arg)
		throw new Error(`overrides: ${path} has no arg ${name} (has ${node.args.map((a) => a.name).join(', ')})`);
	Object.assign(arg, patch);
	for (const k of Object.keys(patch) as (keyof ArgSchema)[]) if (patch[k] === undefined) delete arg[k];
}

function patch(b: SchemaBundle, path: string, p: Partial<DirectiveSchema> & Partial<MatcherSchema>) {
	Object.assign(resolve(b, path), p);
}

/** A `[<matcher>]` that the docs use for a *response* matcher. */
function responseMatcherArg(b: SchemaBundle, path: string) {
	const node = resolve(b, path) as DirectiveSchema;
	node.matcher = false;
	if (!node.args.some((a) => a.name === 'response_matcher'))
		node.args.unshift(
			A('response_matcher', 'matcher', 'A named response matcher (`@name`) or, if omitted, all responses.', {
				optional: true
			})
		);
}

const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'PANIC', 'FATAL'];
const LEVEL_DOC = 'The minimum entry level to log: DEBUG, INFO, WARN, ERROR, PANIC or FATAL.';

export function applyOverrides(b: SchemaBundle): void {
	// --- tls: `tls [internal|force_automate|<email>] | [<cert_file> <key_file>]`
	setArgs(b, 'd:tls', [
		A(
			'email_or_cert',
			'string',
			'An ACME account email, `internal` for a locally-trusted certificate, `force_automate`, or the certificate file when a key file follows.',
			{
				optional: true,
				literals: ['internal', 'force_automate']
			}
		),
		A('key_file', 'path', 'The private key file, when the first argument is a certificate file.', {
			optional: true
		})
	]);
	patch(b, 'd:tls', {
		forms: [
			[
				A('mode', 'enum', 'Use the internal CA, or force automation.', {
					enum: ['internal', 'force_automate']
				})
			],
			[A('email', 'string', 'The email address for the ACME account managing this site’s certificates.')],
			[
				A('cert_file', 'path', 'The certificate file (PEM).'),
				A('key_file', 'path', 'The private key file (PEM).')
			]
		]
	});
	patchArg(b, 'd:tls/client_auth/mode', 'value', {
		name: 'mode',
		optional: undefined,
		doc: 'How to verify client certificates.'
	});
	patchArg(b, 'd:tls/protocols', 'min', { type: 'enum', enum: ['tls1.2', 'tls1.3'] });
	patchArg(b, 'd:tls/protocols', 'max', { type: 'enum', enum: ['tls1.2', 'tls1.3'] });
	patchArg(b, 'd:tls/renewal_window_ratio', 'ratio', { doc: 'A number between 0 and 1.' });

	// --- uri: one directive, five operations
	const uriTarget = A('target', 'string', 'The substring to strip or find.');
	const uriVariants: Record<string, ArgSchema[]> = {
		strip_prefix: [A('target', 'path', 'The prefix to strip from the path.')],
		strip_suffix: [A('target', 'path', 'The suffix to strip from the path.')],
		replace: [
			uriTarget,
			A('replacement', 'string', 'The replacement.'),
			A('limit', 'int', 'How many replacements to make; 0 or omitted means all.', { optional: true })
		],
		path_regexp: [
			A('target', 'regexp', 'The regular expression to find in the path.'),
			A('replacement', 'string', 'The replacement; may use $1-style captures.')
		],
		query: [
			A(
				'param',
				'string',
				'The query parameter. Prefix `-` to delete or `+` to add; with a value it is set. Or open a block with one operation per line.',
				{
					prefixes: ['+', '-'],
					optional: true
				}
			),
			A('value', 'string', 'The value to set or add, or the search term when replacing.', { optional: true }),
			A('replacement', 'string', 'The replacement when renaming or replacing.', { optional: true })
		]
	};
	const uri = resolve(b, 'd:uri') as DirectiveSchema;
	uri.args = [
		A('operation', 'enum', 'The URI manipulation to perform.', { enum: Object.keys(uriVariants) }),
		A('target', 'string', 'The target of the operation (see the chosen operation).', { optional: true }),
		A('replacement', 'string', 'The replacement, for replace, path_regexp and query.', { optional: true }),
		A('limit', 'int', 'For replace: how many replacements to make.', { optional: true })
	];
	uri.forms = Object.entries(uriVariants).map(([op, args]) => [
		A('operation', 'enum', '', { enum: [op] }),
		...args
	]);
	uri.variants = Object.fromEntries(
		Object.entries(uriVariants).map(([op, args]) => [
			op,
			{
				name: op,
				summary: (
					{
						strip_prefix: 'Strips the given prefix from the beginning of the URI path.',
						strip_suffix: 'Strips the given suffix from the end of the URI path.',
						replace: 'Performs a substring replacement across the whole URI.',
						path_regexp: 'Performs a regular expression replacement on the path component of the URI.',
						query: 'Manipulates the query string: set, add (+), delete (-), rename (>) or replace values.'
					} as Record<string, string>
				)[op],
				docsUrl: uri.docsUrl,
				category: uri.category,
				order: -1,
				matcher: false,
				args,
				examples: [],
				...(op === 'query' ? { block: true, freeformBody: true, rows: uri.rows } : {})
			} satisfies DirectiveSchema
		])
	);
	delete uri.rows;

	// --- response matchers inside reverse_proxy / intercept
	responseMatcherArg(b, 'd:reverse_proxy/replace_status');
	patchArg(b, 'd:reverse_proxy/replace_status', 'status_code', { doc: 'The status code to write instead.' });
	responseMatcherArg(b, 'd:reverse_proxy/handle_response');
	responseMatcherArg(b, 'd:reverse_proxy/handle_response/copy_response');
	responseMatcherArg(b, 'd:reverse_proxy/handle_response/copy_response_headers');
	for (const p of [
		'd:reverse_proxy/handle_response/copy_response',
		'd:reverse_proxy/handle_response/copy_response_headers'
	])
		patch(b, p, { onlyIn: ['handle_response'] });
	for (const p of ['d:encode/match', 'd:header/match']) {
		setArgs(b, p, [
			A(
				'criteria',
				'string',
				'Inline response criteria, e.g. `status 2xx` or `header Content-Type text/*`; or a block with one criterion per line.',
				{
					optional: true,
					variadic: true
				}
			)
		]);
		patch(b, p, { block: true, freeformBody: true });
	}

	// --- reverse_proxy details
	patchArg(b, 'd:reverse_proxy/lb_policy/~random_choose', 'n', { type: 'int' });
	patchArg(b, 'd:reverse_proxy/lb_policy/~weighted_round_robin', 'weights', { type: 'int' });
	patchArg(b, 'd:reverse_proxy/transport/~http/versions', 'versions', {
		type: 'enum',
		enum: ['1.1', '2', 'h2c', '3']
	});
	patchArg(b, 'd:reverse_proxy/transport/~http/tls_renegotiation', 'level', {
		type: 'enum',
		enum: ['never', 'once', 'freely'],
		name: 'level'
	});
	patchArg(b, 'd:reverse_proxy/transport/~http/tls_client_auth', 'automate_name', {
		name: 'automate_name_or_cert',
		doc: 'A domain name to automate a client certificate for, or a certificate file when a key file follows.'
	});
	patchArg(b, 'd:reverse_proxy/transport/~http/tls_client_auth', 'cert_file', {
		name: 'key_file',
		optional: true,
		doc: 'The key file, when the first argument is a certificate file.'
	});
	{
		const n = resolve(b, 'd:reverse_proxy/transport/~http/tls_client_auth');
		n.args = n.args.slice(0, 2);
	}
	patchArg(b, 'd:reverse_proxy/request_buffers', 'size', { literals: ['unlimited'] });
	patchArg(b, 'd:reverse_proxy/response_buffers', 'size', { literals: ['unlimited'] });
	patchArg(b, 'd:reverse_proxy/trusted_proxies', 'private_ranges', {
		doc: 'Shortcut for all private IPv4 and IPv6 ranges.'
	});
	patch(b, 'd:reverse_proxy/trusted_proxies', {
		summary: 'Trusts X-Forwarded-* headers from these proxy ranges when forwarding them upstream.'
	});
	patchArg(b, 'd:reverse_proxy/dynamic/~a/versions', 'value', { name: 'versions', variadic: true });
	patchArg(b, 'd:reverse_proxy/dynamic/~srv/proto', 'proto', { type: 'enum', enum: ['tcp', 'udp'] });
	patchArg(b, 'd:reverse_proxy/flush_interval', 'duration', {
		doc: 'A duration; -1 disables buffering (low-latency mode).'
	});

	// --- php_fastcgi and forward_auth are reverse_proxy with presets: they accept every reverse_proxy subdirective
	for (const name of ['php_fastcgi', 'forward_auth']) {
		const d = resolve(b, `d:${name}`) as DirectiveSchema;
		const rp = resolve(b, 'd:reverse_proxy') as DirectiveSchema;
		for (const [k, v] of Object.entries(rp.subdirectives ?? {}))
			if (!d.subdirectives![k]) d.subdirectives![k] = structuredClone(v);
		delete d.freeformBody;
	}
	patchArg(b, 'd:php_fastcgi/index', 'filename', { literals: ['off'] });
	patchArg(b, 'd:forward_auth/copy_headers', 'fields', {
		optional: true,
		doc: 'Header fields to copy; `Old>New` renames. Or list them one per line in a block.'
	});

	// --- other directives
	patchArg(b, 'd:basic_auth', 'hash_algorithm', { type: 'string', literals: ['bcrypt', 'argon2id'] });
	patchArg(b, 'd:encode', 'formats', { literals: ['zstd', 'gzip'] });
	patchArg(b, 'd:encode/gzip', 'level', { type: 'int', doc: 'Compression level 1-9.' });
	patchArg(b, 'd:encode/zstd', 'level', { type: 'enum', enum: ['default', 'fastest', 'better', 'best'] });
	patchArg(b, 'd:redir', 'code', {
		literals: ['temporary', 'permanent', 'html'],
		doc: 'A 3xx status code or 401, `temporary` (302, the default), `permanent` (301), `html` (HTML-based redirect), or a placeholder.'
	});
	patchArg(b, 'd:request_body/max_size', 'value', { name: 'size', type: 'size' });
	patchArg(b, 'd:log_level', 'level', { type: 'enum', enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'] });
	patchArg(b, 'd:log/level', 'level', { type: 'enum', enum: LOG_LEVELS, doc: LEVEL_DOC });
	patchArg(b, 'd:log/output/~file', 'filename', { doc: 'The path to the log file.' });
	patchArg(b, 'd:log/output/~file/roll_keep_for', 'days', {
		name: 'duration',
		type: 'duration',
		doc: 'How long to keep rolled files, as a duration (e.g. 2160h).'
	});
	patchArg(b, 'd:log/output/~file/roll_minutes', 'minutes', { type: 'int' });
	patchArg(b, 'd:log/sampling/first', 'number', { type: 'int' });
	patchArg(b, 'd:log_append', 'key', {
		doc: 'The field name. Prefix `<` to read the value from the response rather than the request.'
	});
	patchArg(b, 'd:file_server/browse/sort', 'sort_field', {
		type: 'enum',
		enum: ['name', 'namedirfirst', 'size', 'time']
	});
	patchArg(b, 'd:file_server/browse/sort', 'direction', { type: 'enum', enum: ['asc', 'desc'] });
	patchArg(b, 'd:file_server/precompressed', 'formats', { literals: ['zstd', 'br', 'gzip'] });
	patchArg(b, 'd:file_server/fs', 'backend', {
		doc: 'The name of a file system declared with the `filesystem` global option.'
	});
	patchArg(b, 'd:import', 'pattern', {
		type: 'path',
		doc: 'A snippet name or a file path or glob to import.'
	});
	patch(b, 'd:import', { block: true, freeformBody: true });
	setArgs(b, 'd:reverse_proxy/transport/~http/tls_trust_pool', [
		A('module', 'string', 'The trust pool provider (see the tls directive), followed by its options.', {
			literals: Object.keys(
				(resolve(b, 'd:tls/client_auth/trust_pool') as DirectiveSchema).variants ?? {}
			).sort()
		}),
		A('options', 'string', 'Provider options.', { optional: true, variadic: true })
	]);
	patch(b, 'd:reverse_proxy/transport/~http/tls_trust_pool', { block: true, freeformBody: true });
	patchArg(b, 'd:handle_path', 'path_matcher', {
		doc: 'A single path matcher token, e.g. `/api/*`. The matched prefix is stripped from the path.'
	});
	{
		const t = resolve(b, 'd:tracing') as DirectiveSchema;
		t.subdirectives!.span_attributes.rows = [
			[
				A('attribute', 'string', 'The attribute name.'),
				A('value', 'string', 'The value; placeholders allowed.')
			]
		];
	}
	patchArg(b, 'd:respond', 'status_or_body', {
		doc: 'A status code, or the response body when a status follows or none is needed.'
	});
	patchArg(b, 'd:error', 'status_or_message', {
		doc: 'A status code, or the error message when a status follows.'
	});
	patchArg(b, 'd:map', 'source', { doc: 'The placeholder to map, e.g. `{host}`.' });
	patchArg(b, 'd:map', 'destinations', {
		type: 'placeholder',
		doc: 'The placeholders to create, e.g. `{my_var}`.'
	});

	// --- global options
	setArgs(b, 'g:storage', [
		A('module', 'string', 'The storage module, e.g. `file_system`.', { literals: ['file_system'] }),
		A('options', 'string', 'Module options inline, or in the block.', { optional: true, variadic: true })
	]);
	setArgs(b, 'g:log', [
		A('name', 'string', 'The logger name; omit for the default logger.', { optional: true })
	]);
	patchArg(b, 'g:log/level', 'level', { type: 'enum', enum: LOG_LEVELS, doc: LEVEL_DOC });
	setArgs(b, 'g:order', [
		A('directive', 'string', 'The directive to position (usually a plugin).'),
		A('position', 'enum', '`first`, `last`, or `before`/`after` another directive.', {
			enum: ['first', 'last', 'before', 'after']
		}),
		A('other', 'string', 'The directive to order relative to, with before/after.', { optional: true })
	]);
	patchArg(b, 'g:email', 'yours', { name: 'email', doc: 'Your email address, used for the ACME account.' });
	patchArg(b, 'g:admin', 'addr', {
		doc: 'The admin API listen address (e.g. `localhost:2019`, `unix//path`), or `off`.'
	});
	patchArg(b, 'g:servers/protocols', 'value', { name: 'protocols', variadic: true, optional: true });
	patchArg(b, 'g:servers/listener_wrappers/proxy_protocol/fallback_policy', 'policy', {
		type: 'enum',
		enum: ['ignore', 'use', 'reject', 'require', 'skip']
	});
	patchArg(b, 'g:servers/trusted_proxies', 'module', { name: 'module', literals: ['static'] });
	patch(b, 'g:servers', {
		summary:
			'Customizes HTTP servers with settings that span multiple sites (listener, timeouts, trusted proxies, protocols). Optionally scoped to one listener address.',
		docsUrl: `${SITE}/docs/caddyfile/options#server-options`
	});
	patch(b, 'g:servers/timeouts', {
		summary:
			'Timeouts for client connections: reading the body and headers, writing responses, and idle keep-alive.'
	});
	patch(b, 'g:pki', {
		summary: 'Configures certificate authorities for local HTTPS and the ACME server.',
		docsUrl: `${SITE}/docs/caddyfile/options#pki-options`
	});
	patch(b, 'g:pki/ca', { summary: 'A certificate authority, by ID (default `local`).' });
	for (const k of ['root', 'intermediate'])
		patch(b, `g:pki/ca/${k}/format`, {
			summary: 'The format of the key pair; only `pem_file` is supported.'
		});
	patch(b, 'g:events', {
		summary: 'Binds handlers to events emitted by Caddy modules.',
		docsUrl: `${SITE}/docs/caddyfile/options#event-options`
	});
	patch(b, 'g:metrics/per_host', {
		summary: 'Labels HTTP metrics with the request host, so metrics are available per site.'
	});
	patch(b, 'g:metrics/observe_catchall_hosts', {
		summary: 'Records metrics for every host, not only configured ones (risk of unbounded cardinality).'
	});
	patch(b, 'g:metrics/otlp', {
		summary:
			'Pushes the same metrics to an OpenTelemetry (OTLP) endpoint configured with OTEL_* environment variables.'
	});
	patch(b, 'g:acme_eab/key_id', { summary: 'The key identifier from the CA.' });
	patch(b, 'g:acme_eab/mac_key', { summary: 'The MAC key from the CA.' });

	// --- request matchers
	const cel = (m: string, form: string) => patch(b, `m:${m}`, { celForm: form });
	setArgs(b, 'm:expression', [
		A(
			'expression',
			'cel',
			'A CEL expression that returns true or false; may use placeholders and other matchers as functions. Usually quoted with backticks.',
			{
				variadic: true
			}
		)
	]);
	patchArg(b, 'm:file', 'files', {
		optional: true,
		doc: 'Files to try; with no arguments the request path itself is tried.'
	});
	cel('expression', '<expression>');
	setArgs(b, 'm:not', [
		A(
			'matcher',
			'matcher',
			'One matcher (e.g. `path /admin*`), or a block of matchers that are AND’ed and then negated.',
			{ variadic: true }
		)
	]);
	patch(b, 'm:not', {
		blockForm: true,
		celForm: '!(<expression>)',
		summary: 'Negates one matcher, or a block of matchers that are AND’ed together.'
	});
	setArgs(b, 'm:protocol', [
		A(
			'protocol',
			'string',
			'`http`, `https`, `grpc`, a specific HTTP version like `http/1.1`, or a minimum version like `http/2+`.',
			{
				literals: ['http', 'https', 'grpc', 'http/1.0', 'http/1.1', 'http/2', 'http/2+', 'http/3', 'http/3+']
			}
		)
	]);
	setArgs(b, 'm:query', [
		A(
			'pairs',
			'string',
			'`key=value` pairs (`*` matches any value), or `""` to match requests without a query string.',
			{ variadic: true }
		)
	]);
	delete (resolve(b, 'm:query') as MatcherSchema).forms;
	setArgs(b, 'm:tls', [
		A(
			'state',
			'enum',
			'Omit to match any TLS request, or `early_data` to match QUIC 0-RTT early data only.',
			{ enum: ['early_data'], optional: true }
		)
	]);
	cel('tls', "tls('any'|'complete'|'early_data')");
	patchArg(b, 'm:url_pattern', 'pattern', { type: 'string' });
	patchArg(b, 'm:method', 'verbs', {
		literals: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']
	});
	patchArg(b, 'm:client_ip', 'ranges', { literals: ['private_ranges'] });
	patchArg(b, 'm:remote_ip', 'ranges', { literals: ['private_ranges'] });
	for (const m of ['client_ip', 'remote_ip', 'host', 'method', 'path']) patch(b, `m:${m}`, { merges: true });
	patch(b, 'm:file', { blockForm: true });

	// --- generic passes
	for (const d of Object.values(b.directives)) moduleLiterals(d);
	for (const d of Object.values(b.globalOptions)) moduleLiterals(d);
}

/** When a node has module variants, offer their names on the first argument. */
function moduleLiterals(node: DirectiveSchema) {
	if (node.variants && node.args[0] && node.args[0].type === 'string' && !node.args[0].literals) {
		node.args[0].literals = Object.keys(node.variants).sort();
	}
	for (const s of Object.values(node.subdirectives ?? {})) moduleLiterals(s);
	for (const v of Object.values(node.variants ?? {})) moduleLiterals(v);
}
