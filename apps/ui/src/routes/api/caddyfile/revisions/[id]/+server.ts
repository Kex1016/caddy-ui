import { json } from '@sveltejs/kit';
import { getConfigService } from '$lib/server/config';
import { noStore } from '$lib/server/config/http';
import type { RequestHandler } from './$types';

/** One revision with its full text. */
export const GET: RequestHandler = ({ params }) => {
	const id = Number(params.id);
	const rev = Number.isSafeInteger(id) ? getConfigService().getRevision(id) : undefined;
	if (!rev) return json({ message: `No revision #${params.id}` }, { status: 404 });
	return json(rev, { headers: noStore });
};
