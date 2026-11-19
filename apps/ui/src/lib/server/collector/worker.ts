import { adminFetch } from '../caddy/admin-fetch';
import { readFileSync, statSync } from 'node:fs';
import type { Config } from '../env';
import type { Db } from '../db';
import { readCerts } from './certs';
import { FileTailer, LogRollup, parseAccessLine, type TailPosition } from './logs';
import { MetricsRollup, parsePrometheus } from './metrics';
import { NetworkMatcher } from '../netlist';
import { probeSite, probeUpstream, type ProbeResult } from './probe';
import { loadProbeOptions, NO_OPTIONS, withPath, type ProbeOptions } from './probe-options';
import {
	HostMatcher,
	probeTarget,
	scanCaddyfile,
	upstreamTarget,
	type SiteBlock,
	type UpstreamTarget
} from './sites';
import {
	getSetting,
	insertMetricRows,
	insertProbes,
	loadStates,
	pruneInBatches,
	recordState,
	replaceCerts,
	setSetting,
	syncSites,
	upsertLogMinutes,
	type ProbeRow,
	type State
} from './store';

export type JobStatus = { lastRun: number | null; lastOk: number | null; error: string | null };

/** What the API reports about each data source, so pages can say "metrics are off" rather than show zeros. */
export type CollectorStatus = {
	startedAt: number;
	caddyfile: JobStatus & { sites: number };
	probes: JobStatus & { intervalMs: number };
	metrics: JobStatus & { intervalMs: number; perHost: boolean };
	logs: JobStatus & {
		path: string;
		found: boolean;
		lastEntry: number | null;
		lagBytes: number;
		/** Entries skipped since start because the client is in `CADDY_UI_LOG_EXCLUDE_NETWORKS`. */
		excluded: number;
	};
	certs: JobStatus & { count: number };
	upstreams: JobStatus;
};

/** One upstream as Caddy's `/reverse_proxy/upstreams` reports it (passive health). */
export type LiveUpstream = { address: string; num_requests: number; fails: number };

/** The last answer from `/reverse_proxy/upstreams`: `data` is null when the admin API did not answer. */
export type LiveUpstreams = { at: number; data: Map<string, LiveUpstream> | null };

/** What changed, for whoever keeps a snapshot of the read side (snapshot.ts). */
export type CollectorEvent = 'probes' | 'sites' | 'upstreams' | 'certs';

/** One target's result in the latest probe cycle; `target` '' is the site itself (notifications, S5). */
export type CycleResult = {
	siteId: string;
	target: string;
	state: State;
	status: number | null;
	error: string | null;
};

const TAIL_KEY = 'collector.log_position';
const LOG_EVERY_MS = 5_000;
/** The log tail is read and parsed this much at a time, yielding between slices so requests get through. */
const LOG_SLICE_BYTES = 1024 * 1024;
const LOG_SLICES_PER_TICK = 8;
const HOURLY = 3_600_000;
const PROBE_CONCURRENCY = 16;
const RETRY_DELAY_MS = 1_000;

/** A repeating job. `ms` is read each time the job is scheduled again, so a new interval applies at once. */
type Loop = { ms: number; fn: () => unknown; timer: NodeJS.Timeout | undefined; running: boolean };

/**
 * Probe timeout: `CADDY_UI_PROBE_TIMEOUT` when set, else a third of the interval, between 2 and 10 seconds.
 * Never longer than the interval, so a cycle that times out still ends before the next one is due.
 */
export const probeTimeout = (intervalMs: number, setMs?: number) =>
	setMs !== undefined
		? Math.min(setMs, Math.max(1_000, intervalMs))
		: Math.min(10_000, Math.max(2_000, intervalMs / 3));

const job = (): JobStatus => ({ lastRun: null, lastOk: null, error: null });

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const run = async () => {
		while (next < items.length) await fn(items[next++] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * The background collector: probes, metrics scrape, access-log tail, certificate scan and retention, each on
 * its own timer inside the UI process. Every step is also callable directly, which is what the tests do.
 */
export class Collector {
	sites: SiteBlock[] = [];
	matcher = new HostMatcher([]);
	readonly status: CollectorStatus;
	/** Bumped whenever the site list changes, so a snapshot knows it is stale. */
	sitesVersion = 0;
	/** The last `/reverse_proxy/upstreams` answer, polled on the scrape timer and never from a page load. */
	live: LiveUpstreams = { at: 0, data: null };
	/** Every result of the latest probe cycle, read on the 'probes' event (the notifier, S5). */
	lastCycle: { ts: number; results: CycleResult[] } = { ts: 0, results: [] };
	private states: Map<string, { state: State; since: number }>;
	private listeners: ((e: CollectorEvent) => void)[] = [];
	private metrics: MetricsRollup;
	private logs: LogRollup;
	private tailer: FileTailer;
	/** Clients whose requests are not counted (`CADDY_UI_LOG_EXCLUDE_NETWORKS`). */
	private excludeNetworks: NetworkMatcher;
	private caddyfileMtime = -1;
	private loops = new Map<string, Loop>();
	private stopped = false;
	readonly connectHost: string;
	private probeTimeoutMs: number;
	/** Per-site probe options (Settings → Monitoring), by site id. */
	probeOptions: Map<string, ProbeOptions>;
	/** Certificates with fewer days left are flagged (`CADDY_UI_CERT_WARN_DAYS`). */
	certWarnDays: number;
	/** While set, the jobs that write to the database wait (Settings → compact database). */
	private held: Promise<void> | null = null;

	constructor(
		private db: Db,
		private cfg: Config,
		private now: () => number = Date.now
	) {
		this.connectHost = new URL(cfg.adminUrl).hostname;
		this.probeTimeoutMs = probeTimeout(cfg.probeIntervalMs, cfg.probeTimeoutMs);
		this.certWarnDays = cfg.certWarnDays;
		this.probeOptions = loadProbeOptions(db);
		this.states = loadStates(db);
		const siteFor = (host: string) => this.matcher.match(host);
		this.metrics = new MetricsRollup(siteFor);
		this.logs = new LogRollup(siteFor);
		this.excludeNetworks = new NetworkMatcher(cfg.logExcludeNetworks);
		const saved = getSetting(db, TAIL_KEY);
		this.tailer = new FileTailer(cfg.logPath, saved ? (JSON.parse(saved) as TailPosition) : undefined);
		this.status = {
			startedAt: now(),
			caddyfile: { ...job(), sites: 0 },
			probes: { ...job(), intervalMs: cfg.probeIntervalMs },
			metrics: { ...job(), intervalMs: cfg.scrapeIntervalMs, perHost: false },
			logs: { ...job(), path: cfg.logPath, found: false, lastEntry: null, lagBytes: 0, excluded: 0 },
			certs: { ...job(), count: 0 },
			upstreams: job()
		};
	}

	/** The current state per `site|target` ('' target is the site), kept in memory as probes record flips. */
	get currentStates(): ReadonlyMap<string, { state: State; since: number }> {
		return this.states;
	}

	/** Calls `fn` after each probe cycle, site list change, upstream poll and certificate scan. */
	onChange(fn: (e: CollectorEvent) => void): () => void {
		this.listeners.push(fn);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== fn);
		};
	}

	private emit(e: CollectorEvent): void {
		for (const fn of this.listeners) {
			try {
				fn(e);
			} catch (err) {
				console.error('caddy-ui collector:', err);
			}
		}
	}

	/** Re-reads the Caddyfile when it changed on disk. Keeps the last good site list if it cannot be read. */
	refreshSites(): void {
		const s = this.status.caddyfile;
		s.lastRun = this.now();
		try {
			const mtime = statSync(this.cfg.caddyfilePath).mtimeMs;
			if (mtime !== this.caddyfileMtime) {
				this.sites = scanCaddyfile(readFileSync(this.cfg.caddyfilePath, 'utf8'));
				this.matcher = new HostMatcher(this.sites);
				this.caddyfileMtime = mtime;
				syncSites(this.db, this.sites, this.now());
				this.sitesVersion++;
				this.emit('sites');
			}
			s.sites = this.sites.length;
			s.lastOk = s.lastRun;
			s.error = null;
		} catch (err) {
			s.error = `Cannot read ${this.cfg.caddyfilePath}: ${errText(err)}`;
		}
	}

	private async withRetry(fn: () => Promise<ProbeResult>): Promise<ProbeResult> {
		const first = await fn();
		if (first.ok || this.stopped) return first;
		// One quick retry so a single dropped packet does not flip a site to down.
		await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
		return fn();
	}

	/**
	 * Where to probe an upstream. A loopback upstream (`localhost:3000`) is local to Caddy, not to this
	 * container, so it is probed on Caddy's host instead.
	 */
	upstreamTarget(address: string): UpstreamTarget | undefined {
		const t = upstreamTarget(address);
		if (t && /^(localhost|127\.\d+\.\d+\.\d+|::1)$/.test(t.host)) return { ...t, host: this.connectHost };
		return t;
	}

	/** Where a site is probed: its first address through Caddy, at the path its probe options name. */
	siteTarget(s: Pick<SiteBlock, 'id' | 'addresses'>) {
		const t = probeTarget(s.addresses, this.connectHost);
		return t ? { ...t, url: withPath(t.url, this.probeOptions.get(s.id)?.path ?? null) } : undefined;
	}

	/** Use new per-site probe options from the next probe cycle on. */
	setProbeOptions(options: Map<string, ProbeOptions>): void {
		this.probeOptions = options;
		this.emit('sites');
	}

	/** Probes every site through Caddy and every upstream directly, once each, and records state flips. */
	async probeAll(): Promise<void> {
		const st = this.status.probes;
		st.lastRun = this.now();
		this.refreshSites();
		const siteResults = new Map<string, ProbeResult>();
		const upstreamResults = new Map<string, ProbeResult>();
		const opts = (id: string) => this.probeOptions.get(id) ?? NO_OPTIONS;
		const probed = this.sites.filter((s) => !opts(s.id).skip);
		const targetOf = (s: SiteBlock) => this.siteTarget(s);
		const siteJobs = probed.flatMap((s) => {
			const t = targetOf(s);
			return t ? [{ id: s.id, t, alsoUp: opts(s.id).upStatuses }] : [];
		});
		const upstreams = [...new Set(probed.flatMap((s) => s.upstreams.map((u) => u.address)))];
		const jobs: (() => Promise<void>)[] = [
			...siteJobs.map(({ id, t, alsoUp }) => async () => {
				siteResults.set(id, await this.withRetry(() => probeSite(t, this.probeTimeoutMs, alsoUp)));
			}),
			...upstreams.map((address) => async () => {
				const t = this.upstreamTarget(address);
				if (!t) return;
				upstreamResults.set(address, await this.withRetry(() => probeUpstream(t, this.probeTimeoutMs)));
			})
		];
		await pool(jobs, PROBE_CONCURRENCY, (j) => j());
		if (this.stopped) return;

		const ts = this.now();
		const rows: ProbeRow[] = [];
		const results: CycleResult[] = [];
		this.db.transaction(() => {
			for (const s of this.sites) {
				if (opts(s.id).skip) {
					// Not probed: say so with "unknown" rather than keep showing the last result.
					for (const u of s.upstreams) recordState(this.db, this.states, s.id, u.address, 'unknown', ts);
					recordState(this.db, this.states, s.id, '', 'unknown', ts);
					continue;
				}
				const own = siteResults.get(s.id);
				if (own)
					rows.push({
						siteId: s.id,
						target: targetOf(s)!.url,
						kind: 'site',
						ts,
						...own
					});
				const ups: ProbeResult[] = [];
				for (const u of s.upstreams) {
					const r = upstreamResults.get(u.address);
					if (!r) continue;
					ups.push(r);
					rows.push({ siteId: s.id, target: u.address, kind: 'upstream', ts, ...r });
					results.push({
						siteId: s.id,
						target: u.address,
						state: r.ok ? 'up' : 'down',
						status: r.status,
						error: r.error
					});
					recordState(this.db, this.states, s.id, u.address, r.ok ? 'up' : 'down', ts);
				}
				// The site is judged by its own probe; without one, by its upstreams (down only if all are down).
				const state: State = own
					? own.ok
						? 'up'
						: 'down'
					: ups.length > 0
						? ups.some((r) => r.ok)
							? 'up'
							: 'down'
						: 'unknown';
				recordState(this.db, this.states, s.id, '', state, ts);
				results.push({
					siteId: s.id,
					target: '',
					state,
					status: own?.status ?? null,
					error: own?.error ?? (state === 'down' ? 'every upstream is down' : null)
				});
			}
			insertProbes(this.db, rows);
		})();
		this.lastCycle = { ts, results };
		st.lastOk = ts;
		st.error = null;
		this.emit('probes');
	}

	/** Polls Caddy's passive health data for upstreams. A failed poll keeps no stale numbers. */
	async pollUpstreams(): Promise<void> {
		const st = this.status.upstreams;
		st.lastRun = this.now();
		let data: Map<string, LiveUpstream> | null = null;
		try {
			const res = await adminFetch(`${this.cfg.adminUrl}/reverse_proxy/upstreams`, {
				signal: AbortSignal.timeout(2_000)
			});
			if (!res.ok)
				throw new Error(`${this.cfg.adminUrl}/reverse_proxy/upstreams answered HTTP ${res.status}`);
			const list = (await res.json()) as LiveUpstream[];
			data = new Map((Array.isArray(list) ? list : []).map((u) => [u.address, u]));
			st.lastOk = this.now();
			st.error = null;
		} catch (err) {
			st.error = errText(err);
		}
		if (this.stopped) return;
		this.live = { at: this.now(), data };
		this.emit('upstreams');
	}

	async scrapeMetrics(): Promise<void> {
		const st = this.status.metrics;
		st.lastRun = this.now();
		try {
			const res = await adminFetch(`${this.cfg.adminUrl}/metrics`, { signal: AbortSignal.timeout(10_000) });
			if (!res.ok) throw new Error(`${this.cfg.adminUrl}/metrics answered HTTP ${res.status}`);
			const rows = this.metrics.feed(parsePrometheus(await res.text()), this.now());
			insertMetricRows(this.db, rows);
			st.perHost = this.metrics.perHost;
			st.lastOk = this.now();
			st.error = null;
		} catch (err) {
			st.error = errText(err);
		}
	}

	/**
	 * Reads what the access log gained since the last tick, in slices of 1 MB (at most 8 MB a tick), and lets
	 * other work run between slices, so catching up on a large backlog never holds the server for long.
	 */
	async tailLogs(pause: () => Promise<void> = () => new Promise((r) => setImmediate(r))): Promise<void> {
		const st = this.status.logs;
		st.lastRun = this.now();
		try {
			const before = this.tailer.position;
			for (let i = 0; i < LOG_SLICES_PER_TICK; i++) {
				if (i > 0) await pause();
				if (this.stopped) return;
				const at = this.tailer.position?.offset;
				const lines = this.tailer.read(LOG_SLICE_BYTES);
				for (const line of lines) {
					const e = parseAccessLine(line);
					if (!e) continue;
					if (this.excludeNetworks.has(e.ip)) {
						// Still marks the minute as read, so a quiet minute shows zero requests rather than a gap.
						this.logs.touch(e.ts);
						st.excluded++;
					} else {
						this.logs.add(e);
					}
					st.lastEntry = Math.max(st.lastEntry ?? 0, e.ts);
				}
				if (this.tailer.position?.offset === at || this.tailer.lagBytes === 0) break;
			}
			st.found = this.tailer.position !== undefined;
			st.lagBytes = this.tailer.lagBytes;
			upsertLogMinutes(this.db, this.logs.take(this.now()));
			const after = this.tailer.position;
			if (after && (before?.offset !== after.offset || before?.ino !== after.ino)) {
				setSetting(this.db, TAIL_KEY, JSON.stringify(after));
			}
			st.lastOk = this.now();
			st.error = null;
		} catch (err) {
			st.error = errText(err);
		}
	}

	scanCerts(): void {
		const st = this.status.certs;
		st.lastRun = this.now();
		try {
			const certs = readCerts(this.cfg.dataPath);
			replaceCerts(this.db, certs, this.now());
			st.count = certs.length;
			st.lastOk = this.now();
			st.error = null;
		} catch (err) {
			st.error = errText(err);
		}
		this.emit('certs');
	}

	/** Retention, in batches with pauses between them. Raw probes are kept for the full retention. */
	async prune(): Promise<{ probes: number; metrics: number }> {
		return pruneInBatches(this.db, this.cfg.retentionDays, this.now());
	}

	/** The probe timeout in force, in ms. */
	get probeTimeout(): number {
		return this.probeTimeoutMs;
	}

	/**
	 * Pause every job that writes to the database, for work that needs the database to itself (compacting it).
	 * Resolves once no job is running; call the returned function to let them run again. Jobs that came due
	 * meanwhile run once when released, so the access-log tail catches up from where it was.
	 */
	async hold(): Promise<() => void> {
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		this.held = held;
		while ([...this.loops.values()].some((l) => l.running)) await new Promise((r) => setTimeout(r, 25));
		return () => {
			if (this.held === held) this.held = null;
			release();
		};
	}

	/** True while `hold()` is in force. */
	get holding(): boolean {
		return this.held !== null;
	}

	private schedule(loop: Loop, delay: number): void {
		const t = setTimeout(() => void this.tick(loop), delay);
		t.unref();
		loop.timer = t;
	}

	private async tick(loop: Loop): Promise<void> {
		loop.timer = undefined;
		if (this.stopped) return;
		while (this.held) await this.held;
		if (this.stopped) return;
		loop.running = true;
		try {
			await loop.fn();
		} catch (err) {
			console.error('caddy-ui collector:', err);
		} finally {
			loop.running = false;
		}
		if (!this.stopped) this.schedule(loop, loop.ms);
	}

	private every(name: string, ms: number, fn: () => unknown, delay = 0): void {
		const loop: Loop = { ms, fn, timer: undefined, running: false };
		this.loops.set(name, loop);
		this.schedule(loop, delay);
	}

	/**
	 * Change a job's interval. A waiting timer is re-armed to fire one new interval from now; a job that is
	 * running picks the new interval up when it schedules its next run.
	 */
	private rearm(name: string, ms: number): void {
		const loop = this.loops.get(name);
		if (!loop || loop.ms === ms) {
			if (loop) loop.ms = ms;
			return;
		}
		loop.ms = ms;
		if (loop.running || loop.timer === undefined || this.stopped) return;
		clearTimeout(loop.timer);
		this.schedule(loop, ms);
	}

	/** The interval a job runs at now, or undefined when the collector was not started. Tests use this. */
	intervalOf(name: 'probes' | 'metrics' | 'upstreams' | 'logs' | 'certs' | 'prune'): number | undefined {
		return this.loops.get(name)?.ms;
	}

	/**
	 * Apply a changed config while running (settings service, plan §2.2): the probe, scrape and upstream-poll
	 * timers are re-armed, retention is read at the next prune, and the excluded networks apply from the next log line. Environment-only fields (paths, admin URL) are not
	 * taken from `next`; they cannot change while the process runs.
	 */
	reconfigure(next: Config): void {
		this.cfg = {
			...this.cfg,
			probeIntervalMs: next.probeIntervalMs,
			scrapeIntervalMs: next.scrapeIntervalMs,
			retentionDays: next.retentionDays,
			probeTimeoutMs: next.probeTimeoutMs,
			certWarnDays: next.certWarnDays,
			logExcludeNetworks: next.logExcludeNetworks
		};
		this.excludeNetworks = new NetworkMatcher(next.logExcludeNetworks);
		this.probeTimeoutMs = probeTimeout(next.probeIntervalMs, next.probeTimeoutMs);
		if (this.certWarnDays !== next.certWarnDays) {
			this.certWarnDays = next.certWarnDays;
			this.emit('certs');
		}
		this.status.probes.intervalMs = next.probeIntervalMs;
		this.status.metrics.intervalMs = next.scrapeIntervalMs;
		this.rearm('probes', next.probeIntervalMs);
		this.rearm('metrics', next.scrapeIntervalMs);
		this.rearm('upstreams', next.scrapeIntervalMs);
	}

	start(): void {
		this.refreshSites();
		this.every('probes', this.cfg.probeIntervalMs, () => this.probeAll());
		this.every('metrics', this.cfg.scrapeIntervalMs, () => this.scrapeMetrics());
		this.every('upstreams', this.cfg.scrapeIntervalMs, () => this.pollUpstreams());
		this.every('logs', LOG_EVERY_MS, () => this.tailLogs());
		this.every('certs', HOURLY, () => this.scanCerts());
		this.every('prune', HOURLY, () => this.prune(), 60_000);
	}

	/** Stops the timers and writes what is buffered for the open minute. */
	stop(): void {
		this.stopped = true;
		for (const loop of this.loops.values()) if (loop.timer) clearTimeout(loop.timer);
		this.loops.clear();
		try {
			insertMetricRows(this.db, this.metrics.flush());
			upsertLogMinutes(this.db, this.logs.take(this.now(), true));
		} catch {
			// The database may already be closed on shutdown.
		}
	}
}
