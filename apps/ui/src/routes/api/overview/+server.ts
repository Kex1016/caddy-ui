import { json } from '@sveltejs/kit';
import { getSnapshot, parseRange, RANGES } from '$lib/server/collector';
import type { RequestHandler } from './$types';

/** Server-wide tiles and series: `?range=1h|24h|7d|30d`, default 24h (PLAN.md §3.2), from the snapshot. */
export const GET: RequestHandler = ({ url, locals }) => {
	const range = parseRange(url.searchParams.get('range'));
	if (!range) {
		return json({ message: `range must be one of ${Object.keys(RANGES).join(', ')}` }, { status: 400 });
	}
	return json(getSnapshot().overview(range, locals.timing), { headers: { 'cache-control': 'no-store' } });
};
