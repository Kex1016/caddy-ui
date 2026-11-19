import type { ApiError } from '$lib/api/porkbun';

/**
 * Send JSON to one of the `/api/porkbun/*` routes from the browser and get back either the answer or an
 * `ApiError` to show with `PorkbunNotice`. A `WriteResult` with `ok: false` (Porkbun refused, answered 502)
 * comes back as that error; so does a 403 from read-only mode or a 404 for a domain not in the account.
 */
export async function sendJson<T>(
	method: 'GET' | 'PUT' | 'POST' | 'DELETE',
	url: string,
	body?: unknown,
	fetcher: typeof fetch = fetch
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
	let res: Response;
	try {
		res = await fetcher(url, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
	} catch {
		return {
			ok: false,
			error: { code: 'UNREACHABLE', message: 'Caddy UI could not be reached.', retryable: true }
		};
	}
	const parsed: unknown = await res.json().catch(() => null);
	const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
	if (res.ok && obj.ok !== false) return { ok: true, data: parsed as T };
	const nested = obj.error;
	if (typeof nested === 'object' && nested !== null && 'code' in nested) {
		return { ok: false, error: nested as ApiError };
	}
	return {
		ok: false,
		error: {
			code: typeof obj.code === 'string' ? obj.code : `HTTP_${res.status}`,
			message: typeof obj.message === 'string' ? obj.message : `The request failed (${res.status}).`,
			retryable: res.status >= 500
		}
	};
}
