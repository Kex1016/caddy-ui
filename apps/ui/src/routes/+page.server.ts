import { getCollector, overview, parseRange, sitesPayload } from '$lib/server/collector';
import { getDb } from '$lib/server/db';
import { config } from '$lib/server/env';
import { foldUpstreams } from '$lib/stats/upstreams';
import type { PageServerLoad } from './$types';

/** Overview: the same payloads as `/api/overview` and `/api/sites`, read in-process. */
export const load: PageServerLoad = async ({ url, depends }) => {
	depends('app:stats');
	const range = parseRange(url.searchParams.get('range')) ?? '24h';
	const c = getCollector();
	const db = getDb();
	const [ov, sites] = await Promise.all([overview(c, db, range), sitesPayload(c, db, config().adminUrl)]);
	return {
		overview: ov,
		down: sites.sites
			.filter((s) => s.status === 'down')
			.map((s) => ({ id: s.id, label: s.label, since: s.since, error: s.probe?.error ?? null })),
		upstreams: foldUpstreams(sites.sites),
		adminOk: sites.sources.admin?.ok ?? false
	};
};
