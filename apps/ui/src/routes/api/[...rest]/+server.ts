import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Unknown API routes answer in JSON, not with the HTML error page. */
export const fallback: RequestHandler = ({ url }) =>
	json({ message: `No API route at ${url.pathname}` }, { status: 404 });
