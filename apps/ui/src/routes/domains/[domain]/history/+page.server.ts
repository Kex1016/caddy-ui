import { isHttpError } from '@sveltejs/kit';
import type { ApiError, Cached, RestorePoint } from '$lib/api/porkbun';
import { cached, isConfigured, porkbun, requireDomain, toApiError } from '$lib/server/porkbun';
import type { PageServerLoad } from './$types';

/** The History tab: the domain's DNS restore points, cached like every Porkbun read. */
export const load: PageServerLoad = async ({
	params
}): Promise<{ history: Cached<RestorePoint[]> | null; historyError: ApiError | null }> => {
	// The layouts redirect when the keys are unset and show the error when the domain is not in the account.
	if (!isConfigured()) return { history: null, historyError: null };
	try {
		const { domain } = await requireDomain(params.domain);
		const pb = porkbun();
		return { history: await cached(`${domain}:history`, () => pb.dns.history(domain)), historyError: null };
	} catch (err) {
		if (isHttpError(err)) return { history: null, historyError: null };
		const historyError = toApiError(err);
		if (!historyError) throw err;
		return { history: null, historyError };
	}
};
