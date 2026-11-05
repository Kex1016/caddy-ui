/**
 * Value grammars for argument types: durations, sizes, status codes, upstream
 * addresses and so on. Each checker returns null when the value is acceptable and a
 * short message otherwise. Values containing placeholders or `{$ENV}` references are
 * only known at runtime, so they always pass.
 */
import type { ArgSchema, ArgType } from './types.ts';

/** Go duration units plus Caddy's `d` (days). */
export const DURATION_RE = /^-?(?:(?:\d+(?:\.\d+)?|\.\d+)(?:ns|us|µs|ms|s|m|h|d))+$/;
/** go-humanize sizes: 512, 4KiB, 10MB, 1.5 GB … */
export const SIZE_RE = /^\d+(?:\.\d+)?\s?(?:[kKmMgGtTpPeE]i?[bB]?|[bB])?$/;
export const INT_RE = /^-?\d+$/;
/** A status code or a class like `5xx`. */
export const STATUS_RE = /^(?:[1-5]\d\d|[1-5]xx)$/i;
/** RFC 7230 header field token, plus `*` wildcards Caddy accepts in some places. */
export const HEADER_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A placeholder `{…}` or a Caddyfile env var `{$…}` anywhere in the value. */
export const PLACEHOLDER_IN_VALUE_RE = /\{[$%?]?[A-Za-z_][^{}\s]*\}/;
/** Upstream: [scheme://]host[:port[-port]] or unix socket. No path allowed. */
export const UPSTREAM_RE =
	/^(?:(?:(?:https?|h2c|wss?|srv\+https?|fastcgi|tcp|udp|ip|quic):\/\/)?(?:\[[0-9A-Fa-f:.%a-z]+\]|[A-Za-z0-9._-]*)(?::\d{1,5}(?:-\d{1,5})?)?|unix(?:\+h2c)?\/\/\S+)$/;

/** Upstream address forms, for docs and pickers. */
export const UPSTREAM_FORMS: { pattern: string; example: string; doc: string }[] = [
	{ pattern: 'host:port', example: 'localhost:8080', doc: 'Plain HTTP to a host and port.' },
	{ pattern: ':port', example: ':8080', doc: 'Port on localhost.' },
	{
		pattern: 'ip:port',
		example: '10.0.0.5:3000',
		doc: 'An IP address and port; IPv6 in brackets, e.g. [::1]:8080.'
	},
	{
		pattern: 'host:port-port',
		example: 'localhost:8001-8006',
		doc: 'A port range expands to one upstream per port.'
	},
	{ pattern: 'http://host[:port]', example: 'http://app:80', doc: 'Explicit HTTP; the port defaults to 80.' },
	{
		pattern: 'https://host[:port]',
		example: 'https://example.com',
		doc: 'HTTPS to the upstream; the port defaults to 443.'
	},
	{ pattern: 'h2c://host:port', example: 'h2c://127.0.0.1:9000', doc: 'Cleartext HTTP/2.' },
	{ pattern: 'unix//path', example: 'unix//run/php/php-fpm.sock', doc: 'A Unix socket.' },
	{
		pattern: 'unix+h2c//path',
		example: 'unix+h2c//run/app.sock',
		doc: 'Cleartext HTTP/2 over a Unix socket.'
	},
	{
		pattern: '{placeholder}',
		example: '{http.request.header.X-Backend}',
		doc: 'Resolved per request; the scheme cannot be a placeholder.'
	}
];

export const DURATION_UNITS = ['ns', 'us', 'µs', 'ms', 's', 'm', 'h', 'd'] as const;
export const SIZE_UNITS = ['B', 'KB', 'KiB', 'MB', 'MiB', 'GB', 'GiB', 'TB', 'TiB'] as const;

export function hasPlaceholder(value: string): boolean {
	return PLACEHOLDER_IN_VALUE_RE.test(value);
}

/** Is `value` a matcher token: `*`, a path starting with `/`, or `@name`? */
export function isMatcherToken(value: string): boolean {
	return value === '*' || value.startsWith('/') || /^@[^\s{}]+$/.test(value);
}

/**
 * Check a value against a type. `arg` supplies enums, literals and prefixes.
 * Regular expressions are checked with the JS engine after translating Go's
 * `(?P<name>` groups; a JS-only failure is reported as a warning by the caller.
 */
export function checkValue(
	type: ArgType,
	value: string,
	arg?: Pick<ArgSchema, 'enum' | 'literals' | 'prefixes'>
): string | null {
	let v = value;
	if (arg?.prefixes?.length && arg.prefixes.includes(v[0] ?? '')) v = v.slice(1);
	if (arg?.literals?.includes(v)) return null;
	if (type !== 'enum' && hasPlaceholder(v)) return null;
	switch (type) {
		case 'string':
		case 'cel':
			return null;
		case 'path':
			return v.length ? null : 'expected a path';
		case 'int':
			return INT_RE.test(v) ? null : `expected a whole number, got "${value}"`;
		case 'duration':
			return DURATION_RE.test(v) || v === '0'
				? null
				: `expected a duration like 30s, 5m or 1h30m, got "${value}"`;
		case 'size':
			return SIZE_RE.test(v) ? null : `expected a size like 512, 4KiB or 10MB, got "${value}"`;
		case 'status':
			return STATUS_RE.test(v) ? null : `expected an HTTP status code like 200 or 5xx, got "${value}"`;
		case 'header':
			return HEADER_RE.test(v) ? null : `"${value}" is not a valid header field name`;
		case 'upstream':
			if (/^[a-z][a-z0-9+]*:\/\/[^/]*\/./i.test(v))
				return `upstream addresses cannot contain a path ("${value}"); use rewrite or handle_path instead`;
			return UPSTREAM_RE.test(v) && v !== ''
				? null
				: `"${value}" is not an upstream address (host:port, scheme://host[:port], or unix//path)`;
		case 'url':
			return /\s/.test(v) || !v ? `"${value}" is not a URL` : null;
		case 'placeholder':
			return /^\{[^{}\s]+\}$/.test(v) ? null : `expected a placeholder like {my_var}, got "${value}"`;
		case 'matcher':
			return isMatcherToken(v) ? null : `expected a matcher token (*, /path or @name), got "${value}"`;
		case 'regexp':
			return checkRegexp(v);
		case 'enum': {
			const allowed = arg?.enum ?? [];
			if (!allowed.length) return null;
			return allowed.some((e) => e === v || e.toLowerCase() === v.toLowerCase())
				? null
				: `expected one of ${allowed.join(', ')}, got "${value}"`;
		}
	}
}

/** RE2 accepts a few forms JS does not; translate the common ones before testing. */
export function checkRegexp(pattern: string): string | null {
	let p = pattern.replace(/\(\?P</g, '(?<');
	let flags = '';
	const inline = /^\(\?([imsU]+)\)/.exec(p);
	if (inline) {
		p = p.slice(inline[0].length);
		flags = (inline[1] ?? '').replace(/U/g, '').replace(/[^ims]/g, '');
	}
	try {
		new RegExp(p, flags);
		return null;
	} catch (e) {
		return `invalid regular expression: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}`;
	}
}
