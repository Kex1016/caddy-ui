import { getSnapshot, pageRange } from '$lib/server/collector';
import { foldUpstreams } from '$lib/stats/upstreams';
import { getPrefs } from '$lib/server/settings';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Overview: the same data as `/api/overview` and `/api/sites`, read from the collector's snapshot. What is up
 * comes at once; the traffic and top parts too when the snapshot has them (the default range), otherwise they
 * are streamed in after the page's shell (docs/settings-and-perf-plan.md §1.3 F).
 */
export const load: PageServerLoad = ({ url, depends, locals, request }) => {
	// The landing page (S6): `/` opens the saved page when the address is typed, bookmarked or followed from
	// outside. A click or a navigation inside this UI says so in Sec-Fetch-Site, and Overview then stays Overview.
	const landing = getPrefs().get().landing;
	const fetchSite = request.headers.get('sec-fetch-site');
	if (landing !== '/' && fetchSite !== 'same-origin' && !url.searchParams.has('home')) redirect(303, landing);
	depends('app:stats');
	const range = pageRange(url.searchParams.get('range'));
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
