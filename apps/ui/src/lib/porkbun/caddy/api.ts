/**
 * The browser's side of the Caddy tie-in API (docs/porkbun-plan.md §4): `GET /api/porkbun/caddy`,
 * `POST /api/porkbun/caddy/records` and `POST /api/porkbun/caddy/challenges`. Every call answers a value,
 * never throws: a failure is `{ ok: false, error }` in the shape `PorkbunNotice` shows.
 */
import type { ApiError, PorkbunFailure, PorkbunStatus } from '$lib/api/porkbun';
import type {
	CaddyTieIn,
	ChallengeCleanupPreview,
	ChallengeCleanupRequest,
	ChallengeCleanupResult,
	RecordFix,
	RecordFixPreview,
	RecordFixRequest,
	RecordFixResult
} from '$lib/api/porkbun-caddy';

export type Answer<T> =
	{ ok: true; data: T } | { ok: false; status: number; error: ApiError; fix?: RecordFix };

function failure(status: number, body: unknown): Answer<never> {
	const b = (body ?? {}) as Partial<PorkbunFailure> & { fix?: RecordFix };
	const error: ApiError = b.error ?? {
		code: typeof b.code === 'string' ? b.code : `HTTP_${status}`,
		message: typeof b.message === 'string' ? b.message : `The request failed (HTTP ${status}).`,
		retryable: status >= 500
	};
	return { ok: false, status, error, ...(b.fix ? { fix: b.fix } : {}) };
}

async function call<T>(url: string, init?: RequestInit): Promise<Answer<T>> {
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch {
		return failure(0, { code: 'UI_UNREACHABLE', message: 'Caddy UI did not answer. Check the connection.' });
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	return res.ok ? { ok: true, data: body as T } : failure(res.status, body);
}

const post = <T>(url: string, body: unknown): Promise<Answer<T>> =>
	call<T>(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});

export function getTieIn(opts: { domain?: string; force?: boolean } = {}): Promise<Answer<CaddyTieIn>> {
	const query = new URLSearchParams();
	if (opts.domain) query.set('domain', opts.domain);
	if (opts.force) query.set('force', '');
	const q = query.toString();
	return call<CaddyTieIn>(`/api/porkbun/caddy${q ? `?${q}` : ''}`);
}

export const getStatus = (): Promise<Answer<PorkbunStatus>> => call<PorkbunStatus>('/api/porkbun/status');

/** Porkbun validates the change and nothing changes. */
export const previewFix = (host: string, expect?: RecordFix): Promise<Answer<RecordFixPreview>> =>
	post<RecordFixPreview>('/api/porkbun/caddy/records', {
		host,
		dryRun: true,
		...(expect ? { expect } : {})
	} satisfies RecordFixRequest);

/** A 502 is Porkbun refusing the write: its body still is a `RecordFixResult`, so it comes back as data. */
export async function applyFix(host: string, expect: RecordFix): Promise<Answer<RecordFixResult>> {
	const body: RecordFixRequest = { host, expect };
	let res: Response;
	try {
		res = await fetch('/api/porkbun/caddy/records', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	} catch {
		return failure(0, { code: 'UI_UNREACHABLE', message: 'Caddy UI did not answer. Check the connection.' });
	}
	const data = (await res.json().catch(() => undefined)) as RecordFixResult | undefined;
	if (res.ok || (res.status === 502 && data && 'result' in data))
		return { ok: true, data: data as RecordFixResult };
	return failure(res.status, data);
}

/** Porkbun validates the deletes and nothing is deleted. */
export const previewCleanup = (domain: string, ids: string[]): Promise<Answer<ChallengeCleanupPreview>> =>
	post<ChallengeCleanupPreview>('/api/porkbun/caddy/challenges', {
		domain,
		ids,
		dryRun: true
	} satisfies ChallengeCleanupRequest);

export const cleanChallenges = (domain: string, ids: string[]): Promise<Answer<ChallengeCleanupResult>> =>
	post<ChallengeCleanupResult>('/api/porkbun/caddy/challenges', {
		domain,
		ids
	} satisfies ChallengeCleanupRequest);
