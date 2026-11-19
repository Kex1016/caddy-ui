import { json } from '@sveltejs/kit';
import type { NotifyError, NotifyTestRequest } from '$lib/notify/types';
import { noStore } from '$lib/server/config/http';
import { getNotifier, NotifyRefused } from '$lib/server/notify';
import type { RequestHandler } from './$types';

/**
 * "Send test": post one event with sample values to Discord now, and answer with what Discord said. Uses the
 * template and webhook in the body when given (typed but not saved yet), else the saved ones.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		const err: NotifyError = {
			message: 'Send a JSON object such as {"event": "site_down"}',
			code: 'INVALID'
		};
		return json(err, { status: 400, headers: noStore });
	}
	try {
		return json(await getNotifier().test(body as NotifyTestRequest), { headers: noStore });
	} catch (err) {
		if (err instanceof NotifyRefused) return json(err.body, { status: err.status, headers: noStore });
		throw err;
	}
};
