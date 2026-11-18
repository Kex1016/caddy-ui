import type { DnssecCheck } from '$lib/porkbun/registry/types';
import { checkDnssec } from '$lib/porkbun/registry/validate';
import { authorOf } from '$lib/server/config/http';
import { cached, porkbun, requireDomain, requireWritable, toResponse, write } from '$lib/server/porkbun';
import {
	badRequest,
	blockedBy,
	body,
	forced,
	fresh,
	preflightNow,
	refuse,
	requireConfirm,
	written
} from '$lib/server/porkbun-registry/http';
import type { RequestHandler } from './$types';

/** The DS records at the registry (`Cached<DnssecRecord[]>`). */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const pb = porkbun();
		return fresh(await cached(`${domain}:dnssec`, () => pb.dnssec.list(domain), { force: forced(url) }));
	} catch (err) {
		return toResponse(err);
	}
};

/**
 * Add a DS record. Body: the `DnssecInput` fields, plus `check?: boolean` and `confirm?: string`.
 *
 * Porkbun has no dry run for DNSSEC, so `check: true` validates the input and answers with the enable-dnssec
 * safety check (`DnssecCheck`) without sending anything to the registry. A real add runs the check again,
 * uncached, refuses with 409 while it reports a blocker, and needs the domain name typed: a DS record that
 * does not match the zone's key takes the whole domain off the internet for validating resolvers.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const input = await body(request);
		if (!input) return badRequest('Send a JSON object');
		const ds = checkDnssec(input);
		if (!ds.ok) return badRequest(ds.message);
		const pb = porkbun();
		requireWritable('domains');

		const preflight = await preflightNow(domain, 'enable-dnssec');
		if (input.check === true) {
			const out: DnssecCheck = { preflight };
			return fresh(out);
		}

		const refused = requireConfirm(input, domain, 'adding the DS record');
		if (refused) return refused;
		const blocked = blockedBy(preflight, 'turning on DNSSEC');
		if (blocked) return blocked;
		const before = await pb.dnssec.list(domain);
		if (before.some((r) => r.keyTag === ds.value.keyTag)) {
			return refuse(
				409,
				'DNSSEC_KEYTAG_EXISTS',
				`A DS record with key tag ${ds.value.keyTag} already exists`
			);
		}
		return written(
			await write({
				scope: 'domains',
				author: authorOf(locals),
				domain,
				action: 'dnssec.create',
				request: ds.value,
				before: { records: before },
				run: (client) => client.dnssec.create(domain, ds.value)
			})
		);
	} catch (err) {
		return toResponse(err);
	}
};
