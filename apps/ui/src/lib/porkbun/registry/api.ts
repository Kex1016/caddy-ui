import type { ApiError } from '$lib/api/porkbun';

/**
 * Browser calls of the History and Registry tabs to their `/api/porkbun/domains/:d/…` routes. Every outcome
 * comes back as a value the page can show; nothing throws.
 */

export type Answer<T> =
	{ ok: true; status: number; data: T } | { ok: false; status: number; error: ApiError; body: unknown };

/** `/api/porkbun/domains/example.com/history`. */
export function domainApi(domain: string, ...path: (string | number)[]): string {
	return ['/api/porkbun/domains', ...[domain, ...path].map((p) => encodeURIComponent(String(p)))].join('/');
}

function asError(status: number, body: unknown): ApiError {
	const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	if (b.error && typeof b.error === 'object') return b.error as ApiError;
	const message = typeof b.message === 'string' ? b.message : `The UI server answered ${status}`;
	const code = typeof b.code === 'string' ? b.code : status === 401 ? 'SIGNED_OUT' : 'HTTP_' + status;
	return { code, message, retryable: status === 429 || status >= 500 };
}

export async function call<T>(
	method: string,
	url: string,
	body?: unknown,
	f: typeof fetch = fetch
): Promise<Answer<T>> {
	let res: Response;
	try {
		res = await f(url, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
	} catch (err) {
		return {
			ok: false,
			status: 0,
			error: {
				code: 'UNREACHABLE',
				message: `Could not reach the UI server: ${String(err)}`,
				retryable: true
			},
			body: null
		};
	}
	let parsed: unknown = null;
	try {
		parsed = await res.json();
	} catch {
		parsed = null;
	}
	if (res.ok) return { ok: true, status: res.status, data: parsed as T };
	return { ok: false, status: res.status, error: asError(res.status, parsed), body: parsed };
}
