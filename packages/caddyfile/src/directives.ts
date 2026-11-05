/**
 * Syntactic knowledge about the standard Caddy HTTP directives that the parser
 * needs in order to classify tokens. The full semantic schema lives in
 * `@caddy-ui/caddy-schema`; the parser only needs to know which directives take
 * a leading matcher token and which ones contain directives in their body.
 *
 * Source: the `## Syntax` block of each page under
 * caddyserver/website `src/docs/markdown/caddyfile/directives/`.
 */

// Caddy's default directive order lives in `@caddy-ui/caddy-schema` (`defaultOrder`); it is not
// duplicated here because the parser does not need it.

/** Directives whose syntax line is `name [<matcher>] ...`. */
export const MATCHER_DIRECTIVES: ReadonlySet<string> = new Set([
	'abort',
	'acme_server',
	'basic_auth',
	'copy_response',
	'copy_response_headers',
	'encode',
	'error',
	'file_server',
	'forward_auth',
	'fs',
	'handle',
	'header',
	'intercept',
	'invoke',
	'log_append',
	'log_level',
	'log_name',
	'log_skip',
	'map',
	'method',
	'metrics',
	'php_fastcgi',
	'push',
	'redir',
	'request_body',
	'request_header',
	'respond',
	'reverse_proxy',
	'rewrite',
	'root',
	'route',
	'templates',
	'timeouts',
	'uri',
	'vars',
	// handle_path takes a required path matcher
	'handle_path'
]);

/** Directives that take no matcher at all (listed for documentation and tests). */
export const MATCHERLESS_DIRECTIVES: ReadonlySet<string> = new Set([
	'bind',
	'handle_errors',
	'import',
	'log',
	'tls',
	'tracing',
	'try_files'
]);

/**
 * Directives whose body is a list of directives, so that matcher detection for
 * `/path` and `*` tokens applies inside. `handle_response` is the
 * `reverse_proxy` / `intercept` subdirective.
 */
export const CONTAINER_DIRECTIVES: ReadonlySet<string> = new Set([
	'handle',
	'handle_errors',
	'handle_path',
	'route',
	'handle_response'
]);

/**
 * Directives whose single positional argument may begin with `/` without
 * being a matcher. Since Caddy 2.8 `root /srv` sets the root; a matcher is
 * only present when there are two or more arguments.
 */
export const PATH_ARG_DIRECTIVES: ReadonlySet<string> = new Set(['root']);

/** All 41 standard directives documented under caddyfile/directives/. */
export const STANDARD_DIRECTIVES: readonly string[] = [
	'abort',
	'acme_server',
	'basic_auth',
	'bind',
	'encode',
	'error',
	'file_server',
	'forward_auth',
	'fs',
	'handle',
	'handle_errors',
	'handle_path',
	'header',
	'import',
	'intercept',
	'invoke',
	'log',
	'log_append',
	'log_level',
	'log_name',
	'log_skip',
	'map',
	'method',
	'metrics',
	'php_fastcgi',
	'push',
	'redir',
	'request_body',
	'request_header',
	'respond',
	'reverse_proxy',
	'rewrite',
	'root',
	'route',
	'templates',
	'timeouts',
	'tls',
	'tracing',
	'try_files',
	'uri',
	'vars'
];
