import { json } from '@sveltejs/kit';
import { caddyTieIn, pluginOnly } from '$lib/server/caddy/porkbun/check';
import { requireDomain, toResponse } from '$lib/server/porkbun';
import type { RequestHandler } from './$types';

/**
 * `CaddyTieIn` (docs/porkbun-plan.md §4): whether the running Caddy has the Porkbun plugin, which sites use
 * the DNS challenge, and for every site address under a Porkbun domain which record answers for it and
 * whether that points at this server.
 *
 * - `?only=plugin` answers `{ plugin }` and asks only Caddy, so it works with the Porkbun keys unset.
 * - `?domain=example.com` limits the answer to one domain (404 when it is not in the account).
 * - `?force` asks Porkbun and Caddy again.
 *
 * With the keys unset the answer is a 200 with the plugin check and no sites.
 */
export const GET: RequestHandler = async ({ url }) => {
	const headers = { 'cache-control': 'no-store' };
	const force = url.searchParams.has('force');
	try {
		if (url.searchParams.get('only') === 'plugin') return json(await pluginOnly(force), { headers });
		const name = url.searchParams.get('domain');
		const domain = name === null ? undefined : (await requireDomain(name)).domain;
		return json(await caddyTieIn({ ...(domain ? { domain } : {}), force }), { headers });
	} catch (err) {
		return toResponse(err);
	}
};
