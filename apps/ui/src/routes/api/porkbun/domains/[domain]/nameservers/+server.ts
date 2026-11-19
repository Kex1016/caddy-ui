import type { NameserverRehearsal } from '$lib/porkbun/registry/types';
import { checkNameservers, sameNameservers } from '$lib/porkbun/registry/validate';
import { authorOf } from '$lib/server/config/http';
import { cached, porkbun, requireDomain, requireWritable, toResponse, write } from '$lib/server/porkbun';
import {
	badRequest,
	blockedBy,
	body,
	forced,
	fresh,
	preflightNow,
	requireConfirm,
	written
} from '$lib/server/porkbun-registry/http';
import type { RequestHandler } from './$types';

/** The nameservers at the registry (`Cached<string[]>`, lower case and sorted). */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const pb = porkbun();
		return fresh(await cached(`${domain}:ns`, () => pb.ns.get(domain), { force: forced(url) }));
	} catch (err) {
		return toResponse(err);
	}
};

/**
 * Replace the nameservers. Body: `{ ns: string[], dryRun?: boolean, confirm?: string }`.
 *
 * Both forms run Porkbun's move-nameservers safety check first, uncached. `dryRun: true` answers with the
 * check and Porkbun's rehearsal of the change (`NameserverRehearsal`) and changes nothing. A real change needs
 * the domain name typed and is refused with 409 (`PreflightBlocked`) while the check reports a blocker, for
 * example active DNSSEC (docs/porkbun-plan.md §3.1 rules 3 and 4).
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const input = await body(request);
		if (!input) return badRequest('Send a JSON object');
		const ns = checkNameservers(input.ns);
		if (!ns.ok) return badRequest(ns.message);
		const pb = porkbun();
		requireWritable('domains');

		const preflight = await preflightNow(domain, 'move-nameservers');
		if (input.dryRun === true) {
			const out: NameserverRehearsal = { dryRun: await pb.ns.dryRunUpdate(domain, ns.value), preflight };
			return fresh(out);
		}

		const refused = requireConfirm(input, domain, 'the nameserver change');
		if (refused) return refused;
		const blocked = blockedBy(preflight, 'this nameserver change');
		if (blocked) return blocked;
		const before = await pb.ns.get(domain);
		if (sameNameservers(before, ns.value)) return badRequest('These are already the nameservers');
		return written(
			await write({
				scope: 'domains',
				author: authorOf(locals),
				domain,
				action: 'ns.update',
				request: { ns: ns.value },
				before: { ns: before },
				run: (client) => client.ns.update(domain, ns.value)
			})
		);
	} catch (err) {
		return toResponse(err);
	}
};
