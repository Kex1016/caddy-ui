import type { ApiError, DomainSummary } from '$lib/api/porkbun';
import { isConfigured, requireDomain, toApiError } from '$lib/server/porkbun';
import type { LayoutServerLoad } from './$types';

/**
 * `data.domain` for every tab: the domain as Porkbun's list has it. A name that is not in the account is a
 * 404. When the list can not be read at all (Porkbun unreachable and nothing cached), `domain` is null and
 * `domainError` says why; the layout then shows that in place of the tab.
 */
export const load: LayoutServerLoad = async ({
	params
}): Promise<{ domain: DomainSummary | null; domainError: ApiError | null }> => {
	// With the keys unset the layout above redirects to /domains; there is nothing to look up.
	if (!isConfigured()) return { domain: null, domainError: null };
	try {
		return { domain: await requireDomain(params.domain), domainError: null };
	} catch (err) {
		const domainError = toApiError(err);
		if (!domainError) throw err;
		return { domain: null, domainError };
	}
};
