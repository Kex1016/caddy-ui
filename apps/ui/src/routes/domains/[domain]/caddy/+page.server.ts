import type { ApiError } from '$lib/api/porkbun';
import type { CaddyTieIn } from '$lib/api/porkbun-caddy';
import { caddyTieIn } from '$lib/server/caddy/porkbun/check';
import { isConfigured, requireDomain, toApiError } from '$lib/server/porkbun';
import type { PageServerLoad } from './$types';

/**
 * The Caddy tab of a domain (docs/porkbun-plan.md §4): the tie-in narrowed to this domain. A Porkbun failure
 * is data (`tieError`), so the tab can say what went wrong; a name that is not in the account is the
 * layout's 404.
 */
export const load: PageServerLoad = async ({
	params
}): Promise<{ tie: CaddyTieIn | null; tieError: ApiError | null }> => {
	// With the keys unset the Domains layout redirects to /domains; there is nothing to look up.
	if (!isConfigured()) return { tie: null, tieError: null };
	try {
		const domain = await requireDomain(params.domain);
		const tie = await caddyTieIn({ domain: domain.domain });
		return { tie, tieError: tie.error ?? null };
	} catch (err) {
		const tieError = toApiError(err);
		if (!tieError) throw err;
		return { tie: null, tieError };
	}
};
