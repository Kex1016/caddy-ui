import { error, json } from '@sveltejs/kit';
import { parseAutoRenewBody, requireDomains, setAutoRenewBulk } from '$lib/porkbun/domains/data.server';
import { authorOf } from '$lib/server/config/http';
import { toResponse } from '$lib/server/porkbun';
import type { RequestHandler } from './$types';

/**
 * Turn auto-renew on or off for many domains. Body `{ "on": false, "domains": ["example.com", …] }`. Every
 * name must be in the account (404 otherwise, before anything is sent). Answers `BulkAutoRenew`: one result
 * per domain, in the order asked, so a partial failure is reported domain by domain. 403 in read-only mode or
 * without the "domains" permission.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await request.json().catch(() => error(400, { message: 'Send JSON.', code: 'BAD_REQUEST' }));
		const { on, domains } = parseAutoRenewBody(body, true);
		const found = await requireDomains(domains);
		const result = await setAutoRenewBulk(found, on, authorOf(locals));
		return json(result, { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return toResponse(err);
	}
};
