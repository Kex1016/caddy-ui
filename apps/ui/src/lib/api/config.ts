/**
 * Response shapes of the config routes (`/api/caddyfile*`, `/api/caddy/*`), shared by the server and the
 * pages. Client-safe: no Node imports.
 */

export type DiagnosticSource = 'parser' | 'schema' | 'adapt' | 'load' | 'service';

/** One problem or hint about a Caddyfile. Lines and columns are 1-based; absent when unknown. */
export type Diagnostic = {
	severity: 'error' | 'warning' | 'info';
	source: DiagnosticSource;
	message: string;
	line?: number;
	column?: number;
	/** The directive Caddy named in a warning, when it named one. */
	directive?: string;
};

/** `GET /api/caddyfile`. `cst` is the parser's tree (PLAN.md §3.2), or null while no parser is wired. */
export type CaddyfileDoc = {
	path: string;
	exists: boolean;
	text: string;
	/** sha256 of the text; send it back as `baseHash` so an edit made elsewhere is not overwritten. */
	hash: string;
	mtimeMs: number | null;
	cst: unknown;
	parser: 'ready' | 'unavailable';
	diagnostics: Diagnostic[];
	/** Whether Caddy is running exactly what the file says. */
	drift: Drift;
	/** Set when the file changed on disk without going through this UI since the last apply. */
	externalChange: ExternalChange | null;
};

export type Drift =
	{ state: 'in_sync' } | { state: 'file_differs'; message: string } | { state: 'unknown'; message: string };

export type ExternalChange = { at: number; hash: string; revisionId: number | null };

export type RevisionSummary = {
	id: number;
	ts: number;
	author: string;
	note: string;
	hash: string;
	bytes: number;
	lines: number;
};

export type Revision = RevisionSummary & { text: string };

/** `PUT /api/caddyfile` and `POST /api/caddyfile/revisions/:id/restore`, on success. */
export type ApplyResult = {
	/** False when the text equals the file and Caddy already runs it: nothing was written or loaded. */
	changed: boolean;
	written: boolean;
	loaded: boolean;
	hash: string;
	revision: RevisionSummary | null;
	diagnostics: Diagnostic[];
};

/** Body of a refused apply (409 conflict, 422 invalid, 502 load failed, 503 Caddy unreachable). */
export type ApplyFailure = {
	message: string;
	code: 'conflict' | 'invalid' | 'load_failed' | 'unreachable' | 'write_failed';
	diagnostics: Diagnostic[];
	/** On a conflict: the hash of what is on disk now. */
	currentHash?: string;
};

/** `POST /api/caddyfile/validate`. */
export type ValidateResult = { ok: boolean; diagnostics: Diagnostic[] };

/** `GET /api/caddy/status`. */
export type CaddyStatus = {
	checkedAt: number;
	reachable: boolean;
	error: string | null;
	version: string | null;
	startedAt: number | null;
	lastReload: { ok: boolean; at: number | null } | null;
	/** sha256 of the running JSON config with keys sorted, or null when unreachable. */
	configHash: string | null;
	file: { path: string; exists: boolean; hash: string };
	drift: Drift;
	externalChange: ExternalChange | null;
};

/** One entry of `GET /api/caddy/upstreams`. */
export type UpstreamStatus = {
	address: string;
	numRequests: number;
	fails: number;
	/** Hosts of the site blocks whose reverse_proxy points here, from the running config. */
	sites: { hosts: string[] }[];
};
