import { json } from '@sveltejs/kit';
import type { WriteResult } from '$lib/api/porkbun';
import { authorOf } from '$lib/server/config/http';
import { requireDomain } from '$lib/server/porkbun';
import {
	applyChanges,
	asWriteResult,
	parseChange,
	readJson,
	readZone,
	respond
} from '$lib/porkbun/records/service.server';
import type { RequestHandler } from './$types';

const noStore = { 'cache-control': 'no-store' };

/**
 * `Cached<DnsZone>`: the records Porkbun lets an account edit (no SOA, no default NS records). Served from
 * the read cache; `?force` asks Porkbun again now.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const domain = await requireDomain(params.domain);
		const zone = await readZone(domain.domain, { force: url.searchParams.has('force') });
		return json(zone, { headers: noStore });
	} catch (err) {
		return respond(err);
	}
};

/**
 * Create one record. The body is a `DnsRecordInput` (`{ host, type, content, ttl?, prio?, notes? }`). An
 * invalid record is a 400 with the fields that are wrong; one that can not exist next to what is in the zone
 * is a 409; neither reaches Porkbun. Answers `WriteResult<{ id, adopted? }>`: `adopted` is true when the same
 * record was already there and its id was taken over instead of making a second one.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		const change = parseChange('create', null, await readJson(request));
		const result = await applyChanges(domain.domain, [change], { author: authorOf(locals) });
		const body: WriteResult<{ id: string; adopted?: boolean }> = asWriteResult(result);
		return json(body, { status: body.ok ? 200 : 502, headers: noStore });
	} catch (err) {
		return respond(err);
	}
};
