import { json } from '@sveltejs/kit';
import { getCollector, parseRange, RANGES, siteStats } from '$lib/server/collector';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Chart series for one site: `?range=1h|24h|7d|30d`, default 24h (PLAN.md §3.2). */
export const GET: RequestHandler = ({ params, url }) => {
	const range = parseRange(url.searchParams.get('range'));
	if (!range) {
		return json({ message: `range must be one of ${Object.keys(RANGES).join(', ')}` }, { status: 400 });
	}
	const body = siteStats(getCollector(), getDb(), params.id, range);
	if (!body) return json({ message: `No site with id ${params.id}` }, { status: 404 });
	return json(body, { headers: { 'cache-control': 'no-store' } });
};
