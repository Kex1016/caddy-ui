import { cached, porkbun, requireDomain, toResponse } from '$lib/server/porkbun';
import { badRequest, forced, fresh } from '$lib/server/porkbun-registry/http';
import { restorePointId } from '$lib/server/porkbun-registry/params';
import type { RequestHandler } from './$types';

/** One restore point against the live zone (`Cached<ZoneDiff>`): what a restore would add back or prune. */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const id = restorePointId(params.id);
		if (id === null) return badRequest('A restore point id is a whole number');
		const pb = porkbun();
		return fresh(
			await cached(`${domain}:history:${id}`, () => pb.dns.diff(domain, id), { force: forced(url) })
		);
	} catch (err) {
		return toResponse(err);
	}
};
