import type { ApiError, Cached, UrlForward } from '$lib/api/porkbun';
import { cached, isConfigured, porkbun, requireDomain, toApiError } from '$lib/server/porkbun';
import type { PageServerLoad } from './$types';

/** The domain's URL forwards, or the reason they can not be read. */
export const load: PageServerLoad = async ({
	params
}): Promise<{ forwards: Cached<UrlForward[]> | null; error: ApiError | null }> => {
	// With the keys unset the layout redirects to /domains; this load runs alongside it and must not call out.
	if (!isConfigured()) return { forwards: null, error: null };
	try {
		const domain = await requireDomain(params.domain);
		const forwards = await cached(`${domain.domain}:forwards`, () => porkbun().forwards.list(domain.domain));
		return { forwards, error: null };
	} catch (err) {
		const error = toApiError(err);
		if (!error) throw err;
		return { forwards: null, error };
	}
};
