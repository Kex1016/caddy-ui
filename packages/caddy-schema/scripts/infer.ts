import type { ArgType } from '../src/types.ts';

/**
 * Guess an argument's value type from the name the docs give it. The guesses are
 * deliberately conservative ('string' when unsure); overrides.ts corrects the
 * ones that matter.
 */
export function inferType(rawName: string, context: string): ArgType {
	const n = rawName
		.replace(/\.\.\.$/, '')
		.toLowerCase()
		.replace(/-/g, '_');
	if (n === 'matcher' || n === 'request_matcher' || n.endsWith('response_matcher')) return 'matcher';
	if (n === 'path_matcher') return 'path';
	if (n === 'expression' || n === 'cel_expression') return 'cel';
	if (/(^|_)(duration|interval|timeout|delay|lifetime|period)s?$/.test(n)) return 'duration';
	if (/(^|_)(size|buffers?)$/.test(n)) return 'size';
	if (/(^|_)(status|status_code|status_codes|code|codes)$/.test(n)) return 'status';
	if (/(^|_)(upstreams?|php_fpm_gateways|ip:port)$/.test(n) || n === 'ip:port') return 'upstream';
	if (/(^|_)(regexp|regex|pattern)$/.test(n) && !context.startsWith('import')) return 'regexp';
	if (/^(fields?|headers?|header_field)$/.test(n)) return 'header';
	if (/(^|_)(url|directory_url|ca_dir_url|endpoint|endpoints)$/.test(n)) return 'url';
	if (n === 'to') return context.startsWith('redir') ? 'url' : 'path';
	if (n === 'uri') return 'path';
	if (
		/(^|_)(path|paths|root|file|files|filename|filenames|pem_file|pem_files|cert_file|key_file|log_file|template_file|folders?|dir)$/.test(
			n
		)
	)
		return 'path';
	if (/(^|_)(num|number|retries|count|max_count|port|ports|days|minutes|limit|length)$/.test(n)) return 'int';
	if (n === 'source' && context.startsWith('map')) return 'placeholder';
	return 'string';
}
