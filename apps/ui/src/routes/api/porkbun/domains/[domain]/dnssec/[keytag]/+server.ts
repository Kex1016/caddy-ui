import { authorOf } from '$lib/server/config/http';
import { porkbun, requireDomain, toResponse, write } from '$lib/server/porkbun';
import { badRequest, body, refuse, requireConfirm, written } from '$lib/server/porkbun-registry/http';
import type { RequestHandler } from './$types';

/**
 * Delete the DS records with this key tag. Body: `{ confirm: '<domain>' }`: the domain name typed. Most
 * registries delete every record with the same key data, so the answer may remove more than one row.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const keyTag = params.keytag;
		if (!/^\d{1,5}$/.test(keyTag) || Number(keyTag) > 65535) {
			return badRequest('A key tag is a whole number from 0 to 65535');
		}
		const input = await body(request);
		if (!input) return badRequest('Send a JSON object');
		const refused = requireConfirm(input, domain, 'deleting the DS record');
		if (refused) return refused;
		const records = await porkbun().dnssec.list(domain);
		const before = records.filter((r) => r.keyTag === keyTag);
		if (before.length === 0) {
			return refuse(404, 'DNSSEC_NOT_FOUND', `There is no DS record with key tag ${keyTag}`);
		}
		return written(
			await write({
				scope: 'domains',
				author: authorOf(locals),
				domain,
				action: 'dnssec.delete',
				request: { keyTag },
				before: { records: before },
				run: (pb) => pb.dnssec.delete(domain, keyTag)
			})
		);
	} catch (err) {
		return toResponse(err);
	}
};
