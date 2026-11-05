import { format, parse, positionAt } from '@caddy-ui/caddyfile';
import type { Diagnostic } from '$lib/api/config';
import { setParser } from './parser';

/** Wire `packages/caddyfile` (W1) into the config service seam. Called once at boot from hooks.server.ts. */
export function installCaddyfileParser(): void {
	setParser({
		parse(text) {
			const result = parse(text);
			const diagnostics: Diagnostic[] = result.diagnostics.map((d) => {
				const pos = positionAt(text, d.span.start);
				return {
					severity: d.severity,
					source: 'parser',
					message: d.message,
					line: pos.line,
					column: pos.column
				};
			});
			return { cst: result.file, diagnostics };
		},
		format(text) {
			return format(text);
		}
	});
}
