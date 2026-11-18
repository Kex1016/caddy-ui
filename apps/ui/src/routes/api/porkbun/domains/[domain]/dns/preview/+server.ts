import { json } from '@sveltejs/kit';
import { requireDomain } from '$lib/server/porkbun';
import { parseChanges, previewChanges, readJson, respond } from '$lib/porkbun/records/service.server';
import type { RequestHandler } from './$types';

/**
 * The dry run of a batch (`Preview`). The body is `{ changes }`, the same list `…/dns/batch` takes. Every
 * change is worked out against a fresh read of the zone, with its record before and after, and Porkbun is
 * asked to rehearse each one it can judge on its own. Nothing is changed.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const domain = await requireDomain(params.domain);
		const changes = parseChanges(await readJson(request));
		return json(await previewChanges(domain.domain, changes), { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return respond(err);
	}
};
