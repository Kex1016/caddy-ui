/**
 * Schema types for Caddyfile directives, matchers and global options.
 *
 * The fields marked "contract" are fixed by PLAN.md §3.2. Everything else is an
 * additive, optional extension (logged in DECISIONS.md) so consumers written
 * against the contract keep working.
 */

/** contract */
export type ArgType =
	| 'string'
	| 'int'
	| 'duration'
	| 'size'
	| 'status'
	| 'path'
	| 'upstream'
	| 'url'
	| 'header'
	| 'enum'
	| 'regexp'
	| 'cel'
	| 'placeholder'
	| 'matcher';

export const ARG_TYPES: readonly ArgType[] = [
	'string',
	'int',
	'duration',
	'size',
	'status',
	'path',
	'upstream',
	'url',
	'header',
	'enum',
	'regexp',
	'cel',
	'placeholder',
	'matcher'
];

/** contract */
export type ArgSchema = {
	name: string;
	type: ArgType;
	enum?: string[];
	optional?: boolean;
	variadic?: boolean;
	doc: string;
	/**
	 * extension: keywords accepted in addition to `type`, e.g. `off` for
	 * `admin off|<addr>` or `unlimited` for `request_buffers`.
	 */
	literals?: string[];
	/** extension: single-character operators that may prefix the value, e.g. `+`, `-`, `?`, `>` on header fields. */
	prefixes?: string[];
	/**
	 * extension: the value is a credential. Written out in the file it would also end up in every saved
	 * revision, so a literal value gets a warning that suggests this placeholder instead, e.g.
	 * `{env.PORKBUN_API_KEY}`.
	 */
	secret?: string;
};

/** contract (category gains 'global' for global options, which the contract implies) */
export type DirectiveCategory =
	'routing' | 'handler' | 'middleware' | 'request' | 'response' | 'tls' | 'logging' | 'misc' | 'global';

/** contract */
export type DirectiveSchema = {
	name: string;
	summary: string;
	docsUrl: string;
	category: DirectiveCategory;
	/** Position in Caddy's default directive order; -1 when the directive is not ordered (subdirectives, global options, `import`, `bind`, …). */
	order: number;
	/** Accepts `[<matcher>]` as its first argument. */
	matcher: boolean;
	args: ArgSchema[];
	subdirectives?: Record<string, DirectiveSchema>;
	/** Body holds HTTP handler directives (handle, route, handle_errors, handle_path, handle_response). */
	allowsDirectives?: boolean;
	examples: string[];

	/** extension: the syntax lines as the docs print them, for hover docs. */
	syntax?: string[];
	/** extension: alternative argument lists when the docs give several forms (e.g. `uri strip_prefix …` vs `uri replace …`). `args` is the union. */
	forms?: ArgSchema[][];
	/**
	 * extension: module-style subdirectives whose first argument picks a module with its
	 * own options, e.g. `transport http { … }`, `dynamic srv { … }`, `lb_policy cookie …`,
	 * `issuer acme { … }`, `output file …`. Keyed by the module name.
	 */
	variants?: Record<string, DirectiveSchema>;
	/** extension: the body takes free-form rows rather than named subdirectives (e.g. `basic_auth` user rows, `map` rows, `header` field rows). */
	freeformBody?: boolean;
	/** extension: argument patterns for free-form body rows, e.g. `[<username>, <hashed_password>]` for basic_auth. */
	rows?: ArgSchema[][];
	/** extension: the body takes response matcher definitions (`@name { status … }`). */
	allowsResponseMatchers?: boolean;
	/** extension: the directive only exists inside another (e.g. `copy_response` inside `handle_response`). */
	onlyIn?: string[];
	/** extension: true when the docs mark it experimental. */
	experimental?: boolean;
	/** extension: a block may follow (`{ … }`). */
	block?: boolean;
	/**
	 * extension: the node is not part of standard Caddy. It is the Caddy module ID of the plugin that must be
	 * compiled in for it to work, e.g. `dns.providers.porkbun`. `docsUrl` then points at the plugin.
	 */
	plugin?: string;
	/** extension: subdirectives that must be present in the block, e.g. both keys of `dns porkbun { … }`. */
	requires?: string[];
};

/** contract */
export type MatcherSchema = {
	name: string;
	args: ArgSchema[];
	blockForm?: boolean;
	celForm: string;
	docsUrl: string;
	/** extension */
	summary?: string;
	/** extension */
	syntax?: string[];
	/** extension */
	examples?: string[];
	/** extension: several of this matcher in one named matcher are OR'ed (client_ip, header, …) instead of AND'ed. */
	merges?: boolean;
	/** extension: options inside the matcher's block form (e.g. `file { root … try_files … }`). */
	subdirectives?: Record<string, DirectiveSchema>;
	/** extension: alternative argument lists when the docs give several single-line forms. */
	forms?: ArgSchema[][];
};

/** contract: same shape as a directive, category 'global'. */
export type GlobalOptionSchema = DirectiveSchema;

/** A placeholder from the catalogue. `{path.N}` style entries use `N` / `*` as parameter markers. */
export type PlaceholderSchema = {
	/** The placeholder text including braces, e.g. `{http.request.host}` or `{path.N}`. */
	name: string;
	/** The Caddyfile shorthand, when this is a long form that has one (or vice versa). */
	shorthand?: string;
	longForm?: string;
	doc: string;
	/** Where the placeholder is available. */
	scope: 'global' | 'http' | 'reverse_proxy' | 'error' | 'tls' | 'file' | 'matcher' | 'snippet';
	/** True when the name contains a parameter such as N, Field, name or *. */
	parameterized?: boolean;
};

/** The syntax forms a matcher token can take. */
export type MatcherTokenForm = {
	name: 'wildcard' | 'path' | 'named';
	pattern: string;
	doc: string;
	docsUrl: string;
};

export type SchemaSource = {
	repo: string;
	commit: string;
	committedAt: string;
};

export type SchemaBundle = {
	/** Bumped when the bundle shape changes. */
	schemaVersion: number;
	source: SchemaSource;
	directives: Record<string, DirectiveSchema>;
	matchers: Record<string, MatcherSchema>;
	responseMatchers: Record<string, MatcherSchema>;
	matcherTokenForms: MatcherTokenForm[];
	globalOptions: Record<string, GlobalOptionSchema>;
	/** Caddy's default directive order, including `copy_response` and `copy_response_headers`. */
	defaultOrder: string[];
	placeholders: PlaceholderSchema[];
};
