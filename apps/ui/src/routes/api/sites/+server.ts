import { json } from '@sveltejs/kit';
import { getCollector, sitesPayload } from '$lib/server/collector';
import { getDb } from '$lib/server/db';
import { config } from '$lib/server/env';
import type { RequestHandler } from './$types';

/** Site blocks with current status, upstreams and certificate expiry (PLAN.md §3.2). */
export const GET: RequestHandler = async () => {
	const body = await sitesPayload(getCollector(), getDb(), config().adminUrl);
	return json(body, { headers: { 'cache-control': 'no-store' } });
};
