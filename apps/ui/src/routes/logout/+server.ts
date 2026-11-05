import { config } from '$lib/server/env';
import { isHttps } from '$lib/server/guard';
import { SESSION_COOKIE } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies, request }) => {
	cookies.delete(SESSION_COOKIE, { path: '/', secure: isHttps(request.headers, config().publicUrl) });
	return new Response(null, { status: 303, headers: { location: '/login' } });
};
