import { json } from '@sveltejs/kit';
import { getConfigService } from '$lib/server/config';
import { authorOf, failure, noStore, readTextBody } from '$lib/server/config/http';
import type { RequestHandler } from './$types';

/** Raw text, CST (when the parser is installed), diagnostics, drift against the running config. */
export const GET: RequestHandler = async () => {
	try {
		return json(await getConfigService().document(), { headers: noStore });
	} catch (err) {
		return failure(err);
	}
};

/** `{ text, baseHash?, note? }`: validate with the parser and `/adapt`, back up, write, `/load`. */
export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		const body = await readTextBody(request, ['baseHash', 'note'] as const);
		const result = await getConfigService().apply(body.text, {
			author: authorOf(locals),
			note: body.note,
			baseHash: body.baseHash
		});
		return json(result, { headers: noStore });
	} catch (err) {
		return failure(err);
	}
};
