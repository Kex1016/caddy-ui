import { json } from '@sveltejs/kit';
import { loadOverview } from '$lib/porkbun/domains/data.server';
import { requireDomain, toResponse } from '$lib/server/porkbun';
import type { RequestHandler } from './$types';

/**
 * `DomainOverview`: the domain as `/domain/get` reports it, its renewal price, a nameserver summary and the
 * counts the Overview tab links from. Each part is cached and can fail on its own (`{ ok: false, error }`).
 * 404 for a name that is not in the account. `?force` reads Porkbun again now.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const domain = await requireDomain(params.domain);
		const overview = await loadOverview(domain, { force: url.searchParams.has('force') });
		return json(overview, { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return toResponse(err);
	}
};
