import { error } from '@sveltejs/kit';
import { getCollector, parseRange, siteStats, sitesPayload } from '$lib/server/collector';
import { getDb } from '$lib/server/db';
import { config } from '$lib/server/env';
import type { PageServerLoad } from './$types';

/** One site: live status from `/api/sites` and its series from `/api/sites/:id/stats`, read in-process. */
export const load: PageServerLoad = async ({ params, url, depends }) => {
	depends('app:stats');
	const range = parseRange(url.searchParams.get('range')) ?? '24h';
	const c = getCollector();
	const db = getDb();
	const stats = siteStats(c, db, params.id, range);
	if (!stats)
		error(404, 'No site with this id. It may have been renamed; its history stays under the old id.');
	const sites = await sitesPayload(c, db, config().adminUrl);
	const site = sites.sites.find((s) => s.id === params.id) ?? null;
	return { stats, site, adminOk: sites.sources.admin?.ok ?? false };
};
