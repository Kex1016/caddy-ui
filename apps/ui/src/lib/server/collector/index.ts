import { config } from '../env';
import { getDb } from '../db';
import { onSettingsChange } from '../settings';
import { Snapshot } from './snapshot';
import { Collector } from './worker';

export { Collector } from './worker';
export { parseRange, RANGES, type Range } from './queries';
export { getDefaultRange, pageRange, setDefaultRange, Snapshot, type Part } from './snapshot';
export {
	joinOverview,
	overview,
	overviewStatus,
	overviewTop,
	overviewTraffic,
	siteStats,
	sitesPayload,
	type OverviewPayload,
	type OverviewStatus,
	type OverviewTop,
	type OverviewTraffic,
	type ProbeView,
	type SitesPayload,
	type SiteView,
	type SourceSummary,
	type UpstreamView
} from './views';

const KEY = Symbol.for('caddy-ui.collector');
const SNAP = Symbol.for('caddy-ui.snapshot');
type G = typeof globalThis & { [KEY]?: Collector; [SNAP]?: Snapshot };

/** The process-wide collector, created on first use. Kept on globalThis so dev-server reloads reuse it. */
export function getCollector(): Collector {
	const g = globalThis as G;
	g[KEY] ??= new Collector(getDb(), config());
	return g[KEY];
}

/** The process-wide read model over the collector: what pages and the stats API read. */
export function getSnapshot(): Snapshot {
	const g = globalThis as G;
	g[SNAP] ??= new Snapshot(getCollector(), getDb());
	return g[SNAP];
}

let started = false;

export function startCollector(): void {
	if (started) return;
	started = true;
	getSnapshot();
	const c = getCollector();
	c.start();
	const off = onSettingsChange((next) => c.reconfigure(next));
	process.once('sveltekit:shutdown', () => {
		off();
		c.stop();
	});
}
