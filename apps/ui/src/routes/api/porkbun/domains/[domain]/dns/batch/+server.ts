import { json } from '@sveltejs/kit';
import { authorOf } from '$lib/server/config/http';
import { requireDomain } from '$lib/server/porkbun';
import { applyChanges, parseChanges, readJson, respond } from '$lib/porkbun/records/service.server';
import type { RequestHandler } from './$types';

/**
 * Apply a reviewed list of creates, edits and deletes, in order (`BatchResult`). The body is
 * `{ changes, confirm? }`; `confirm` must be the domain name when the list deletes more than one record.
 *
 * Nothing is sent unless every change can be: an invalid record is a 400, a change that clashes with the zone
 * as it is now (or with an earlier change of the list) is a 409 carrying the plan. Once writes go out, the
 * first failure stops the batch and the changes after it are reported as `not_applied`. The answer is 200
 * when everything went through and 207 when it did not, with the outcome of every change either way.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		const raw = await readJson(request);
		const changes = parseChanges(raw);
		const confirm = (raw as { confirm?: unknown }).confirm;
		const result = await applyChanges(domain.domain, changes, { author: authorOf(locals), confirm });
		return json(result, { status: result.ok ? 200 : 207, headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return respond(err);
	}
};
