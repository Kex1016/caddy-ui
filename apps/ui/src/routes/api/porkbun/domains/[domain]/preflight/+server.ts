import type { PreflightIntent } from '$lib/api/porkbun';
import { cached, porkbun, requireDomain, toResponse } from '$lib/server/porkbun';
import { badRequest, forced, fresh } from '$lib/server/porkbun-registry/http';
import { PREFLIGHT_INTENTS } from '$lib/server/porkbun-registry/params';
import type { RequestHandler } from './$types';

/**
 * Porkbun's safety check for the domain (`Cached<Preflight>`). `?intent=` is general (the default),
 * move-nameservers, transfer-out or enable-dnssec. Read-only. The nameserver and DNSSEC routes run it again
 * themselves, uncached, before they change anything.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const intent = (url.searchParams.get('intent') || 'general') as PreflightIntent;
		if (!PREFLIGHT_INTENTS.includes(intent)) {
			return badRequest(`"intent" is one of ${PREFLIGHT_INTENTS.join(', ')}`);
		}
		const pb = porkbun();
		return fresh(
			await cached(`${domain}:preflight:${intent}`, () => pb.dns.preflight(domain, intent), {
				force: forced(url)
			})
		);
	} catch (err) {
		return toResponse(err);
	}
};
