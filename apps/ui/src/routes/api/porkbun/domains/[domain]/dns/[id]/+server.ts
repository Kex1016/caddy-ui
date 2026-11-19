import { json } from '@sveltejs/kit';
import { authorOf } from '$lib/server/config/http';
import { requireDomain } from '$lib/server/porkbun';
import {
	applyChanges,
	asWriteResult,
	parseChange,
	readJson,
	requireRecordId,
	respond
} from '$lib/porkbun/records/service.server';
import type { RequestHandler } from './$types';

const noStore = { 'cache-control': 'no-store' };

/**
 * Change one record. The body is `{ record, expect? }`: the whole record as it should be, and optionally the
 * record as it was read. Only the fields that differ from the live record are sent to Porkbun. When `expect`
 * no longer matches the live record the answer is a 409 and nothing is sent, so a change made somewhere else
 * in the meantime is not overwritten. The type of a record can not be changed.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		const change = parseChange('edit', requireRecordId(params.id), await readJson(request));
		const result = await applyChanges(domain.domain, [change], { author: authorOf(locals) });
		const body = asWriteResult(result);
		return json(body, { status: body.ok ? 200 : 502, headers: noStore });
	} catch (err) {
		return respond(err);
	}
};

/** Delete one record. An optional body `{ expect }` guards against deleting a record that was changed since. */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		const id = requireRecordId(params.id);
		const change = parseChange('delete', id, await readJson(request, { optional: true }));
		const result = await applyChanges(domain.domain, [change], { author: authorOf(locals) });
		const body = asWriteResult(result);
		return json(body, { status: body.ok ? 200 : 502, headers: noStore });
	} catch (err) {
		return respond(err);
	}
};
