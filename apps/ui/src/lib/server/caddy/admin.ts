import { adminFetch } from './admin-fetch';
import type { Diagnostic } from '$lib/api/config';

/**
 * Thin client for Caddy's admin API (https://caddyserver.com/docs/api). Every call has a timeout and
 * separates "Caddy did not answer" (AdminUnreachableError) from "Caddy answered with an error" (AdminError).
 */

export class AdminUnreachableError extends Error {
	constructor(adminUrl: string, cause: unknown) {
		const why = cause instanceof Error ? (cause.name === 'TimeoutError' ? 'timed out' : cause.message) : '';
		super(`Caddy admin API at ${adminUrl} is unreachable${why ? ` (${why})` : ''}`);
		this.name = 'AdminUnreachableError';
	}
}

export class AdminError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'AdminError';
	}
}

export type AdaptResult =
	{ ok: true; config: unknown; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };

type CaddyWarning = { file?: string; line?: number; directive?: string; message?: string };

const CADDYFILE = 'text/caddyfile';

/** First "Caddyfile:12" in a Caddy error message, as a line number. */
export function lineFromCaddyError(message: string): number | undefined {
	const m = /\bCaddyfile:(\d+)\b/.exec(message);
	if (!m) return undefined;
	const n = Number(m[1]);
	return n > 0 ? n : undefined;
}

/**
 * Caddy's error text without the generic adapter prefix and, when it leads the message, the
 * "Caddyfile:12 - Error during parsing:" location, which the diagnostic carries as `line` instead.
 */
export function cleanCaddyError(message: string): string {
	return message
		.replace(/^adapting config using caddyfile:\s*/i, '')
		.replace(/^Caddyfile:\d+(?::| -)\s*(?:Error during parsing:\s*)?/, '')
		.trim();
}

function warningToDiagnostic(w: CaddyWarning): Diagnostic {
	const d: Diagnostic = { severity: 'warning', source: 'adapt', message: w.message ?? 'Warning from Caddy' };
	if (w.line && w.line > 0) d.line = w.line;
	if (w.directive) d.directive = w.directive;
	return d;
}

export type AdminClientOptions = { timeoutMs?: number; fetch?: typeof fetch };

export class CaddyAdmin {
	private readonly timeoutMs: number;
	private readonly fetchFn: typeof fetch;

	constructor(
		readonly baseUrl: string,
		opts: AdminClientOptions = {}
	) {
		this.timeoutMs = opts.timeoutMs ?? 10_000;
		this.fetchFn = opts.fetch ?? adminFetch;
	}

	private async call(method: string, path: string, body?: string, contentType?: string): Promise<Response> {
		const headers: Record<string, string> = {};
		if (contentType) headers['content-type'] = contentType;
		try {
			return await this.fetchFn(this.baseUrl + path, {
				method,
				headers,
				body,
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch (err) {
			throw new AdminUnreachableError(this.baseUrl, err);
		}
	}

	private static async errorText(res: Response): Promise<string> {
		const raw = await res.text().catch(() => '');
		try {
			const parsed = JSON.parse(raw) as { error?: unknown };
			if (typeof parsed.error === 'string') return parsed.error;
		} catch {
			// not JSON; fall through to the raw text
		}
		return raw.trim() || `HTTP ${res.status}`;
	}

	private async ok(res: Response): Promise<Response> {
		if (!res.ok) throw new AdminError(res.status, await CaddyAdmin.errorText(res));
		return res;
	}

	/** The running config as JSON (`GET /config/`); null when Caddy runs with an empty config. */
	async getConfig(): Promise<unknown> {
		const res = await this.ok(await this.call('GET', '/config/'));
		const text = await res.text();
		return text.trim() === '' ? null : (JSON.parse(text) as unknown);
	}

	/** Adapt a Caddyfile to JSON without loading it (`POST /adapt`). Caddy errors become diagnostics. */
	async adapt(text: string): Promise<AdaptResult> {
		const res = await this.call('POST', '/adapt', text, CADDYFILE);
		if (res.ok) {
			const body = (await res.json()) as { result?: unknown; warnings?: CaddyWarning[] };
			return {
				ok: true,
				config: body.result ?? null,
				diagnostics: (body.warnings ?? []).map(warningToDiagnostic)
			};
		}
		const raw = await CaddyAdmin.errorText(res);
		if (res.status >= 500 && !/caddyfile/i.test(raw)) throw new AdminError(res.status, raw);
		const d: Diagnostic = { severity: 'error', source: 'adapt', message: cleanCaddyError(raw) };
		const line = lineFromCaddyError(raw);
		if (line) d.line = line;
		return { ok: false, diagnostics: [d] };
	}

	/** Load a Caddyfile into the running server (`POST /load`). Caddy keeps the old config if this fails. */
	async load(text: string): Promise<void> {
		await this.ok(await this.call('POST', '/load', text, CADDYFILE));
	}

	/** `GET /reverse_proxy/upstreams`: one entry per upstream with active requests and remembered fails. */
	async upstreams(): Promise<{ address: string; num_requests: number; fails: number }[]> {
		const res = await this.ok(await this.call('GET', '/reverse_proxy/upstreams'));
		const body = (await res.json()) as unknown;
		return Array.isArray(body) ? (body as { address: string; num_requests: number; fails: number }[]) : [];
	}

	/** Prometheus text from `GET /metrics`. */
	async metrics(): Promise<string> {
		const res = await this.ok(await this.call('GET', '/metrics'));
		return res.text();
	}
}
