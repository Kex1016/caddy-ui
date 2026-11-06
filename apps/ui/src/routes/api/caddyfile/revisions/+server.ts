import { json } from '@sveltejs/kit';
import { getConfigService } from '$lib/server/config';
import { noStore } from '$lib/server/config/http';
import type { RequestHandler } from './$types';

/** Newest first, without the text; at most the last 200 are kept. */
export const GET: RequestHandler = () =>
	json({ revisions: getConfigService().listRevisions() }, { headers: noStore });
