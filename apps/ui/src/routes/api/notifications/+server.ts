import { json } from '@sveltejs/kit';
import type { NotifyError, NotifyPatch } from '$lib/notify/types';
import { authorOf, noStore } from '$lib/server/config/http';
import { getNotifier, NotifyRefused } from '$lib/server/notify';
import type { RequestHandler } from './$types';

/**
 * Discord notifications (docs/settings-and-perf-plan.md §3.1, DECISIONS.md S5): the thresholds, each event's
 * message, whether a webhook is saved (never the URL) and the latest deliveries.
 */
export const GET: RequestHandler = () => json(getNotifier().view(), { headers: noStore });

/**
 * Save any of `{ webhook, downCycles, flapMinutes, events, retryComponents }` (see NotifyPatch). Everything is
 * checked first and saved together, or nothing is. The answer is the new view, without the URL.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		const err: NotifyError = { message: 'Send a JSON object such as {"downCycles": 3}', code: 'INVALID' };
		return json(err, { status: 400, headers: noStore });
	}
	try {
		return json(getNotifier().update(body as NotifyPatch, authorOf(locals)), { headers: noStore });
	} catch (err) {
		if (err instanceof NotifyRefused) return json(err.body, { status: err.status, headers: noStore });
		throw err;
	}
};
