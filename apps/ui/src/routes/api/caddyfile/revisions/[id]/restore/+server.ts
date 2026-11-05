import { json } from '@sveltejs/kit';
import { getConfigService } from '$lib/server/config';
import { authorOf, failure, noStore } from '$lib/server/config/http';
import type { RequestHandler } from './$types';

/** Roll back: apply an old revision through the same validate → write → load path. */
export const POST: RequestHandler = async ({ params, locals }) => {
	const id = Number(params.id);
	if (!Number.isSafeInteger(id)) return json({ message: `No revision #${params.id}` }, { status: 404 });
	try {
		const result = await getConfigService().restore(id, authorOf(locals));
		if (!result) return json({ message: `No revision #${id}` }, { status: 404 });
		return json(result, { headers: noStore });
	} catch (err) {
		return failure(err);
	}
};
