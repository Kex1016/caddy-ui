import type { Diagnostic } from '$lib/api/config';

/**
 * The seam between the config service and the Caddyfile parser (`packages/caddyfile`, W1) and schema
 * (`packages/caddy-schema`, W2). Until those packages land, no parser is installed: the service still
 * validates every write with Caddy's own `/adapt`, `cst` is null, and formatting answers 501.
 * When W1 merges, install it at startup with `setParser({ parse, format })` (see DECISIONS.md).
 */
export type CaddyfileParser = {
	/** Parse to the CST of PLAN.md §3.2 plus parser (and, when available, schema) diagnostics. */
	parse(text: string): { cst: unknown; diagnostics: Diagnostic[] };
	/** `caddy fmt` style formatting. */
	format(text: string): string;
};

let installed: CaddyfileParser | null = null;

export function setParser(parser: CaddyfileParser | null): void {
	installed = parser;
}

export function getParser(): CaddyfileParser | null {
	return installed;
}
