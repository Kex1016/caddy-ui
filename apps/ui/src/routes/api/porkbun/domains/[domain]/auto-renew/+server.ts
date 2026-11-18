import { error, json } from '@sveltejs/kit';
import { parseAutoRenewBody, setAutoRenew } from '$lib/porkbun/domains/data.server';
import { authorOf } from '$lib/server/config/http';
import { requireDomain, toResponse } from '$lib/server/porkbun';
import type { RequestHandler } from './$types';

/**
 * Turn auto-renew on or off for one domain. Body `{ "on": true }`. Answers `WriteResult<{ results }>`, with
 * one entry in `results` saying what Porkbun did; 502 when Porkbun refused or could not be reached, 403 in
 * read-only mode or without the "domains" permission.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		const body = await request.json().catch(() => error(400, { message: 'Send JSON.', code: 'BAD_REQUEST' }));
		const { on } = parseAutoRenewBody(body, false);
		const result = await setAutoRenew([domain], on, authorOf(locals));
		return json(result, { status: result.ok ? 200 : 502, headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return toResponse(err);
	}
};
