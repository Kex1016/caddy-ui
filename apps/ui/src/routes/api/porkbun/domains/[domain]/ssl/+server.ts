import { json } from '@sveltejs/kit';
import { porkbun, requireDomain, toResponse } from '$lib/server/porkbun';
import { inspectBundle } from '$lib/server/porkbun-ssl';
import type { RequestHandler } from './$types';

/**
 * The certificate Porkbun issued, described (`SslInfo`). Fetched from Porkbun on every call and never cached:
 * the bundle holds a private key, which this answer never carries.
 */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const domain = await requireDomain(params.domain);
		const bundle = await porkbun().ssl.retrieve(domain.domain);
		return json(inspectBundle(bundle), { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return toResponse(err);
	}
};
