import { getSnapshot, parseRange } from '$lib/server/collector';
import { foldUpstreams } from '$lib/stats/upstreams';
import type { PageServerLoad } from './$types';

/**
 * Overview: the same data as `/api/overview` and `/api/sites`, read from the collector's snapshot. What is up
 * comes at once; the traffic and top parts too when the snapshot has them (the default range), otherwise they
 * are streamed in after the page's shell (docs/settings-and-perf-plan.md §1.3 F).
 */
export const load: PageServerLoad = ({ url, depends, locals }) => {
	depends('app:stats');
	const range = parseRange(url.searchParams.get('range')) ?? '24h';
	const snap = getSnapshot();
	const t = locals.timing;
	const sites = snap.sitesPayload(t);
	const { status, traffic, top } = snap.overviewParts(range, t);
	return {
		range,
		status,
		traffic,
		top,
		down: sites.sites
			.filter((s) => s.status === 'down')
			.map((s) => ({ id: s.id, label: s.label, since: s.since, error: s.probe?.error ?? null })),
		upstreams: foldUpstreams(sites.sites),
		adminOk: sites.sources.admin?.ok ?? false
	};
};
