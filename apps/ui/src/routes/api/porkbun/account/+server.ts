import { json } from '@sveltejs/kit';
import { loadAccount } from '$lib/porkbun/domains/data.server';
import { toResponse } from '$lib/server/porkbun';
import type { RequestHandler } from './$types';

/**
 * `AccountInfo`: prepaid credit and the account's API spend settings, read-only. Each half is
 * `{ ok: false, error }` on its own when the key may not read it. `?force` reads Porkbun again now.
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const account = await loadAccount({ force: url.searchParams.has('force') });
		return json(account, { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return toResponse(err);
	}
};
