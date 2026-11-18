import { isHttpError, json } from '@sveltejs/kit';
import type { ApiError, PorkbunFailure } from '$lib/api/porkbun';

/** Porkbun's `next_action`: how to recover. Branch on `type` and `retryable`, never on the hint's wording. */
export type NextAction = { type: string; hint?: string; url?: string; retryable: boolean };

/** Codes Porkbun marks as transient even when an answer carries no `next_action`. */
const RETRYABLE_CODES = new Set([
	'RATE_LIMIT_EXCEEDED',
	'IDEMPOTENCY_KEY_IN_USE',
	'DNS_READ_FAILED',
	'DNSSEC_INFO_UNAVAILABLE'
]);

export type PorkbunErrorInit = {
	code: string;
	message: string;
	httpStatus: number;
	nextAction?: NextAction | null;
	requestId?: string;
	retryAfter?: number;
	details?: Record<string, unknown>;
};

/** Porkbun answered and said no. `code` is stable; `message` is for people and may be reworded. */
export class PorkbunError extends Error {
	readonly code: string;
	readonly httpStatus: number;
	readonly nextAction: NextAction | null;
	readonly requestId: string | undefined;
	/** Seconds, on a rate limit. */
	readonly retryAfter: number | undefined;
	/** The other fields of the error body (`existingId`, `conflictingRecords`, `requiredScope`, …). */
	readonly details: Record<string, unknown>;

	constructor(init: PorkbunErrorInit) {
		super(init.message);
		this.name = 'PorkbunError';
		this.code = init.code;
		this.httpStatus = init.httpStatus;
		this.nextAction = init.nextAction ?? null;
		this.requestId = init.requestId;
		this.retryAfter = init.retryAfter;
		this.details = init.details ?? {};
	}

	get retryable(): boolean {
		return this.nextAction ? this.nextAction.retryable : RETRYABLE_CODES.has(this.code);
	}
}

/** The keys are not (both) set, so no call can be made. */
export class PorkbunNotConfigured extends Error {
	constructor(readonly missing: 'PORKBUN_API_KEY' | 'PORKBUN_API_SECRET_KEY' | 'both') {
		super(
			missing === 'both' ? 'PORKBUN_API_KEY and PORKBUN_API_SECRET_KEY are not set' : `${missing} is not set`
		);
		this.name = 'PorkbunNotConfigured';
	}
}

/** No usable answer: the network failed, the request timed out, or the reply was not JSON. */
export class PorkbunUnreachable extends Error {
	constructor(
		message: string,
		readonly reason: 'timeout' | 'network' | 'bad_response'
	) {
		super(message);
		this.name = 'PorkbunUnreachable';
	}
}

function httpsUrl(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	try {
		return new URL(raw).protocol === 'https:' ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** The error as the browser gets it, or null when `err` is not one of this module's errors. */
export function toApiError(err: unknown): ApiError | null {
	if (err instanceof PorkbunError) {
		const out: ApiError = { code: err.code, message: err.message, retryable: err.retryable };
		if (err.nextAction?.hint) out.hint = err.nextAction.hint;
		const url = httpsUrl(err.nextAction?.url);
		if (url) out.url = url;
		if (err.requestId) out.requestId = err.requestId;
		if (err.retryAfter !== undefined) out.retryAfter = err.retryAfter;
		if (Object.keys(err.details).length > 0) out.details = err.details;
		return out;
	}
	if (err instanceof PorkbunUnreachable) {
		return { code: 'UNREACHABLE', message: err.message, retryable: true };
	}
	if (err instanceof PorkbunNotConfigured) {
		return {
			code: 'NOT_CONFIGURED',
			message: `${err.message}, so the Domains area is off`,
			hint: 'Add both variables to the caddy-ui service and restart it.',
			retryable: false
		};
	}
	return null;
}

function statusFor(err: unknown): number {
	if (err instanceof PorkbunNotConfigured || err instanceof PorkbunUnreachable) return 503;
	if (err instanceof PorkbunError) {
		if (err.httpStatus === 429 || err.code === 'RATE_LIMIT_EXCEEDED') return 429;
		if (err.httpStatus === 403 || err.httpStatus === 404 || err.httpStatus === 409) return err.httpStatus;
		// Porkbun refused the request as sent: the same class as this API's own "invalid" answers.
		if (err.httpStatus >= 400 && err.httpStatus < 500) return 422;
		return 502;
	}
	return 500;
}

const noStore = { 'cache-control': 'no-store' };

/**
 * For `+server.ts` files: turn this module's errors into a JSON response (`PorkbunFailure`). SvelteKit's own
 * `error(…)` and anything unknown are thrown on, so a 404 from `requireDomain` or a real bug keep their path.
 */
export function toResponse(err: unknown): Response {
	if (isHttpError(err)) throw err;
	const error = toApiError(err);
	if (!error) throw err;
	const body: PorkbunFailure = { message: error.message, code: error.code, error };
	const headers: Record<string, string> = { ...noStore };
	if (error.retryAfter !== undefined) headers['retry-after'] = String(error.retryAfter);
	return json(body, { status: statusFor(err), headers });
}

/**
 * Returns a function that blanks the given secrets wherever they appear in a string. Used on everything that
 * leaves the client (error messages, error details) and on every audit row, so a key can not ride out in an
 * echo of the request even if Porkbun or a proxy were to send one back.
 */
export function redactor(secrets: readonly (string | undefined)[]): (text: string) => string {
	const list = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
	return (text) => {
		let out = text;
		for (const s of list) out = out.split(s).join('[redacted]');
		return out;
	};
}

/** `redact` applied to every string in a JSON value, keys included. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
	if (typeof value === 'string') return redact(value) as T;
	if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[redact(k)] = redactDeep(v, redact);
		return out as T;
	}
	return value;
}
