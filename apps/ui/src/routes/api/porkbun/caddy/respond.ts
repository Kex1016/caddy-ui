import { json } from '@sveltejs/kit';
import { TieInRefusal } from '$lib/server/caddy/porkbun/actions';
import { toResponse } from '$lib/server/porkbun';

const noStore = { 'cache-control': 'no-store' };

/** The JSON body of a POST, or undefined when it is not JSON. */
export async function readJson(request: Request): Promise<unknown> {
	try {
		return (await request.json()) as unknown;
	} catch {
		return undefined;
	}
}

export const ok = (body: unknown, status = 200): Response => json(body, { status, headers: noStore });

/** This API's own refusals as JSON; everything else the way every `/api/porkbun/*` route answers. */
export function failure(err: unknown): Response {
	if (err instanceof TieInRefusal) return json(err.body, { status: err.status, headers: noStore });
	return toResponse(err);
}
