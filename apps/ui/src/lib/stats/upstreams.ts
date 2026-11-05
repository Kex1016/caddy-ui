/** Folds the per-site upstream views of `/api/sites` into one row per upstream address, worst state first. */

type State = 'up' | 'down' | 'unknown';
type UpstreamIn = {
	address: string;
	via: string;
	status: State;
	since: number | null;
	probe: { latencyMs: number | null; error: string | null } | null;
	activeRequests: number | null;
	fails: number | null;
};
type SiteIn = { id: string; label: string; upstreams: UpstreamIn[] };

export type UpstreamRow = {
	address: string;
	via: string[];
	status: State;
	since: number | null;
	latencyMs: number | null;
	error: string | null;
	activeRequests: number | null;
	fails: number | null;
	sites: { id: string; label: string }[];
};

const RANK: Record<State, number> = { down: 0, unknown: 1, up: 2 };

export function foldUpstreams(sites: SiteIn[]): UpstreamRow[] {
	const map = new Map<string, UpstreamRow>();
	for (const s of sites) {
		for (const u of s.upstreams) {
			let row = map.get(u.address);
			if (!row) {
				row = {
					address: u.address,
					via: [],
					status: u.status,
					since: u.since,
					latencyMs: u.probe?.latencyMs ?? null,
					error: u.probe?.error ?? null,
					activeRequests: u.activeRequests,
					fails: u.fails,
					sites: []
				};
				map.set(u.address, row);
			} else if (RANK[u.status] < RANK[row.status]) {
				row.status = u.status;
				row.since = u.since;
				row.error = u.probe?.error ?? row.error;
			}
			if (!row.via.includes(u.via)) row.via.push(u.via);
			if (!row.sites.some((x) => x.id === s.id)) row.sites.push({ id: s.id, label: s.label });
		}
	}
	return [...map.values()].sort(
		(a, b) => RANK[a.status] - RANK[b.status] || a.address.localeCompare(b.address)
	);
}
