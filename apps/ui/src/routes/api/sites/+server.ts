import { json } from '@sveltejs/kit';
import { getSnapshot } from '$lib/server/collector';
import type { RequestHandler } from './$types';

/** Site blocks with current status, upstreams and certificate expiry (PLAN.md §3.2), from the snapshot. */
export const GET: RequestHandler = ({ locals }) => {
	const body = getSnapshot().sitesPayload(locals.timing);
	return json(body, { headers: { 'cache-control': 'no-store' } });
};
