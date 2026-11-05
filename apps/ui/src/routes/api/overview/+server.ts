import { json } from '@sveltejs/kit';
import { getCollector, overview, parseRange, RANGES } from '$lib/server/collector';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Server-wide tiles and series: `?range=1h|24h|7d|30d`, default 24h (PLAN.md §3.2). */
export const GET: RequestHandler = async ({ url }) => {
	const range = parseRange(url.searchParams.get('range'));
	if (!range) {
		return json({ message: `range must be one of ${Object.keys(RANGES).join(', ')}` }, { status: 400 });
	}
	return json(await overview(getCollector(), getDb(), range), { headers: { 'cache-control': 'no-store' } });
};
