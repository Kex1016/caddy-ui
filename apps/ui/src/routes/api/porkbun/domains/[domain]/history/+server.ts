import { cached, porkbun, requireDomain, toResponse } from '$lib/server/porkbun';
import { forced, fresh } from '$lib/server/porkbun-registry/http';
import type { RequestHandler } from './$types';

/** The domain's DNS restore points, newest first (`Cached<RestorePoint[]>`). `?force` asks Porkbun now. */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const pb = porkbun();
		return fresh(await cached(`${domain}:history`, () => pb.dns.history(domain), { force: forced(url) }));
	} catch (err) {
		return toResponse(err);
	}
};
