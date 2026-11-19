import type { Db } from '../db';
import { Timing, type Step } from '../timing';
import { RANGES, type Range } from './queries';
import {
	joinOverview,
	overviewStatus,
	overviewTop,
	overviewTraffic,
	sitesPayload,
	type OverviewPayload,
	type OverviewStatus,
	type OverviewTop,
	type OverviewTraffic,
	type SitesPayload
} from './views';
import type { Collector, CollectorEvent } from './worker';

/** The Overview range the collector keeps ready after every probe cycle: the saved display preference (S6). */
let defaultRange: Range = '24h';
export function getDefaultRange(): Range {
	return defaultRange;
}
/** The range a page opens on: `?range=` when valid, else the saved default. */
export function pageRange(param: string | null): Range {
	return param && param in RANGES ? (param as Range) : defaultRange;
}
export function setDefaultRange(range: Range): void {
	defaultRange = range;
}

/** Other ranges are remembered for one step of the range, and never longer than this. */
const MAX_RANGE_TTL_MS = 5 * 60_000;

type Built<T> = { value: T; builtAt: number; steps: Step[] };

/** A part a page can show now (`value`) or must wait for (`promise`, computed after the shell went out). */
export type Part<T> = T | Promise<T>;

function build<T>(fn: (t: Timing) => T, now: number): Built<T> {
	const t = new Timing();
	const value = fn(t);
	return { value, builtAt: now, steps: t.steps };
}

/**
 * The read model pages and `/api/sites`, `/api/overview` use (docs/settings-and-perf-plan.md §1.3 C). The
 * collector rebuilds the sites payload and the default Overview after every probe cycle, and the sites payload
 * again after each upstream poll, certificate scan and site list change, so a page load reads memory instead
 * of the database. Other Overview ranges are computed when asked for and remembered for one step of the range
 * (at most five minutes).
 */
export class Snapshot {
	private sites: (Built<SitesPayload> & { version: number }) | undefined;
	private sitesStale = true;
	private building = false;
	private status: Built<OverviewStatus> | undefined;
	/** Overview traffic and top parts by `range:part`. */
	private parts = new Map<string, Built<unknown>>();

	constructor(
		private c: Collector,
		private db: Db,
		private now: () => number = Date.now
	) {
		c.onChange((e) => this.changed(e));
	}

	/** Rebuilds in the collector's own turn, so the next page load finds everything ready. */
	private changed(e: CollectorEvent): void {
		this.sitesStale = true;
		if (e === 'certs' || e === 'sites') this.status = undefined;
		if (this.building) return; // a build read the Caddyfile for the first time; it picks the change up itself
		this.sitesPayload();
		// The probe timer is the heartbeat: the default Overview is rebuilt with it, off the request path.
		if (e === 'probes') this.rebuildOverview(defaultRange);
	}

	private rebuildOverview(range: Range): void {
		const now = this.now();
		this.status = build((t) => overviewStatus(this.c, this.db, now, t), now);
		this.parts.set(
			`${range}:traffic`,
			build((t) => overviewTraffic(this.db, range, now, t), now)
		);
		this.parts.set(
			`${range}:top`,
			build((t) => overviewTop(this.c, this.db, range, now, t), now)
		);
	}

	/** True when the sites payload can be read without building it first. */
	get sitesReady(): boolean {
		return this.sites !== undefined && !this.sitesStale && this.sites.version === this.c.sitesVersion;
	}

	/** The `/api/sites` payload, rebuilt first only when something changed since the last build. */
	sitesPayload(t?: Timing): SitesPayload {
		if (!this.sitesReady) {
			const now = this.now();
			this.building = true;
			try {
				const b = build((bt) => sitesPayload(this.c, this.db, now, bt), now);
				this.sites = { ...b, version: this.c.sitesVersion };
			} finally {
				this.building = false;
			}
			this.sitesStale = false;
			t?.addAll(this.sites!.steps);
		} else {
			t?.addAll(this.sites!.steps, 'snapshot');
		}
		const sites = this.sites!;
		t?.add('snapshot', undefined, `age ${Math.round((this.now() - sites.builtAt) / 1000)} s`);
		// How far the access log tail is behind the file (cause 6 in the plan), measured at its last read.
		t?.add('tail', undefined, `lag ${this.c.status.logs.lagBytes} B`);
		return sites.value;
	}

	overviewStatus(t?: Timing): OverviewStatus {
		if (!this.status) {
			const now = this.now();
			this.status = build((bt) => overviewStatus(this.c, this.db, now, bt), now);
			t?.addAll(this.status.steps);
		} else t?.addAll(this.status.steps, 'snapshot');
		return this.status.value;
	}

	private fresh<T>(range: Range, b: Built<T> | undefined): b is Built<T> {
		if (!b) return false;
		// The default range is rebuilt by the probe timer; the cap only matters when that timer is not running.
		const ttl = range === defaultRange ? MAX_RANGE_TTL_MS : Math.min(RANGES[range].stepMs, MAX_RANGE_TTL_MS);
		return this.now() - b.builtAt < ttl;
	}

	private part<V>(
		range: Range,
		key: 'traffic' | 'top',
		compute: (now: number, t: Timing) => V,
		t: Timing | undefined,
		streamed: boolean
	): Part<V> {
		const have = this.parts.get(`${range}:${key}`) as Built<V> | undefined;
		if (this.fresh(range, have)) {
			t?.addAll(have.steps, 'snapshot');
			return have.value;
		}
		const run = () => {
			const now = this.now();
			const b = build((bt) => compute(now, bt), now);
			this.parts.set(`${range}:${key}`, b);
			t?.addAll(b.steps, streamed ? 'streamed' : undefined);
			return b.value;
		};
		return streamed ? (t ?? new Timing()).defer(`${key}-part`, run) : run();
	}

	/**
	 * The Overview for a page: the status part now, the traffic and top parts now when they are in the snapshot,
	 * otherwise as promises computed after the page's shell has been sent.
	 */
	overviewParts(range: Range, t?: Timing) {
		return {
			status: this.overviewStatus(t),
			traffic: this.part(range, 'traffic', (now, bt) => overviewTraffic(this.db, range, now, bt), t, true),
			top: this.part(range, 'top', (now, bt) => overviewTop(this.c, this.db, range, now, bt), t, true)
		};
	}

	/** The whole `/api/overview` payload (PLAN.md §3.2), from the snapshot where it can. */
	overview(range: Range, t?: Timing): OverviewPayload {
		const status = this.overviewStatus(t);
		const traffic = this.part(
			range,
			'traffic',
			(now, bt) => overviewTraffic(this.db, range, now, bt),
			t,
			false
		);
		const top = this.part(range, 'top', (now, bt) => overviewTop(this.c, this.db, range, now, bt), t, false);
		return joinOverview(status, traffic as OverviewTraffic, top as OverviewTop);
	}
}
