import { json } from '@sveltejs/kit';
import type { PorkbunFailure } from '$lib/api/porkbun';

/** A refusal made by this UI before any call to Porkbun, in the same shape as `toResponse` (`PorkbunFailure`). */
export function refuse(message: string, status = 400, code = 'BAD_REQUEST'): Response {
	const body: PorkbunFailure = { message, code, error: { code, message, retryable: false } };
	return json(body, { status, headers: { 'cache-control': 'no-store' } });
}
