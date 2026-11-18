import type { ApiError } from '$lib/api/porkbun';
import type { SslInfo } from '$lib/porkbun/forwarding/ssl';
import { isConfigured, porkbun, requireDomain, toApiError } from '$lib/server/porkbun';
import { inspectBundle } from '$lib/server/porkbun-ssl';
import type { PageServerLoad } from './$types';

/**
 * Details of the certificate Porkbun issued. Asked of Porkbun on every visit and kept nowhere. The private key
 * stays on the server: `info` has no key in it.
 */
export const load: PageServerLoad = async ({
	params
}): Promise<{ info: SslInfo | null; error: ApiError | null; checkedAt: number }> => {
	const checkedAt = Date.now();
	if (!isConfigured()) return { info: null, error: null, checkedAt };
	try {
		const domain = await requireDomain(params.domain);
		return { info: inspectBundle(await porkbun().ssl.retrieve(domain.domain)), error: null, checkedAt };
	} catch (err) {
		const error = toApiError(err);
		if (!error) throw err;
		return { info: null, error, checkedAt };
	}
};
