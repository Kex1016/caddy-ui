import { json } from '@sveltejs/kit';
import { loadDomainList } from '$lib/porkbun/domains/data.server';
import { toResponse } from '$lib/server/porkbun';
import type { RequestHandler } from './$types';

/**
 * `DomainList`: every domain in the account, each with its renewal price from Porkbun's price list. Cached;
 * `?force` reads Porkbun again now. A price list that can not be read leaves the prices empty and says why in
 * `pricingError`; only a list that can not be read at all (and is not cached) is an error.
 */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const list = await loadDomainList({ force: url.searchParams.has('force') });
		return json(list, { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return toResponse(err);
	}
};
