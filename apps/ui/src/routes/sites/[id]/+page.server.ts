import { error, fail } from '@sveltejs/kit';
import { AdminError, AdminUnreachableError } from '$lib/server/caddy/admin';
import { SiteEditError, addPorkbunToSite } from '$lib/server/caddy/porkbun/site-edit';
import { getCollector, getSnapshot, parseRange, siteStats } from '$lib/server/collector';
import { getConfigService } from '$lib/server/config';
import { authorOf } from '$lib/server/config/http';
import { ApplyError } from '$lib/server/config/service';
import { getDb } from '$lib/server/db';
import { isConfigured } from '$lib/server/porkbun';
import type { Actions, PageServerLoad } from './$types';

/** One site: live status from `/api/sites` and its series from `/api/sites/:id/stats`, read in-process. */
export const load: PageServerLoad = async ({ params, url, depends, locals }) => {
	depends('app:stats');
	const range = parseRange(url.searchParams.get('range')) ?? '24h';
	const c = getCollector();
	const db = getDb();
	const stats = locals.timing.measure('stats', () => siteStats(c, db, params.id, range));
	if (!stats)
		error(404, 'No site with this id. It may have been renamed; its history stays under the old id.');
	const sites = getSnapshot().sitesPayload(locals.timing);
	const site = sites.sites.find((s) => s.id === params.id) ?? null;
	// With Porkbun keys the page asks `/api/porkbun/caddy` for its DNS panel, after it has rendered.
	return { stats, site, adminOk: sites.sources.admin?.ok ?? false, porkbunOn: isConfigured() };
};

export const actions: Actions = {
	/** Give this site the Porkbun DNS challenge (the wildcard hint). The keys are written as placeholders. */
	dns01: async ({ params, locals }) => {
		const svc = getConfigService();
		try {
			const file = await svc.readFile();
			const next = addPorkbunToSite(file.text, params.id);
			const names = next.addresses.join(', ');
			const res = await svc.apply(next.text, {
				author: authorOf(locals),
				note: `Added the Porkbun DNS challenge to ${names}`,
				baseHash: file.hash
			});
			return {
				ok: true as const,
				message: `${names} now gets its certificate through the Porkbun DNS challenge.${res.loaded ? ' Caddy reloaded.' : ''}`
			};
		} catch (err) {
			if (err instanceof SiteEditError) {
				return fail(err.code === 'not_found' ? 404 : 409, { message: err.message });
			}
			if (err instanceof ApplyError) return fail(err.status, { message: err.body.message });
			if (err instanceof AdminUnreachableError || err instanceof AdminError)
				return fail(503, { message: err.message });
			throw err;
		}
	}
};
