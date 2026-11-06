import { format, parse, positionAt } from '@caddy-ui/caddyfile';
import { schema } from '@caddy-ui/caddy-schema';
import { validateBlocks } from '@caddy-ui/caddy-schema/validate';
import type { Diagnostic } from '$lib/api/config';
import { cstToBlocks, LineIndex } from '$lib/editor/analyze';
import { setParser } from './parser';

/**
 * Wire `packages/caddyfile` (W1) and the schema validator (W2) into the config service seam. Called once
 * at boot from hooks.server.ts.
 *
 * Schema findings are reported as warnings at most (source `schema`): the schema is generated from the
 * docs and can lag Caddy or miss a plugin, so only the parser and Caddy's own `/adapt` may refuse an
 * apply. The text editor shows the same findings with their own severity (DECISIONS.md, W6).
 */
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
			const { blocks } = cstToBlocks(result.file, new LineIndex(text));
			for (const d of validateBlocks(schema, blocks)) {
				diagnostics.push({
					severity: d.severity === 'error' ? 'warning' : d.severity,
					source: 'schema',
					message: d.message,
					line: d.line,
					directive: d.path[0]
				});
			}
			return { cst: result.file, diagnostics };
		},
		format(text) {
			return format(text);
		}
	});
}
