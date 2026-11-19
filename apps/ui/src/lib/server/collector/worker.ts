import { adminFetch } from '../caddy/admin-fetch';
import { readFileSync, statSync } from 'node:fs';
import type { Config } from '../env';
import type { Db } from '../db';
import { readCerts } from './certs';
import { FileTailer, LogRollup, parseAccessLine, type TailPosition } from './logs';
import { MetricsRollup, parsePrometheus } from './metrics';
import { probeSite, probeUpstream, type ProbeResult } from './probe';
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
	prune,
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
	logs: JobStatus & { path: string; found: boolean; lastEntry: number | null };
	certs: JobStatus & { count: number };
};

const TAIL_KEY = 'collector.log_position';
const LOG_EVERY_MS = 5_000;
const HOURLY = 3_600_000;
const PROBE_CONCURRENCY = 16;
const RETRY_DELAY_MS = 1_000;

/** A repeating job. `ms` is read each time the job is scheduled again, so a new interval applies at once. */
type Loop = { ms: number; fn: () => unknown; timer: NodeJS.Timeout | undefined; running: boolean };

/** Probe timeout: a third of the interval, between 2 and 10 seconds. */
const probeTimeout = (intervalMs: number) => Math.min(10_000, Math.max(2_000, intervalMs / 3));

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
	private states: Map<string, { state: State; since: number }>;
	private metrics: MetricsRollup;
	private logs: LogRollup;
	private tailer: FileTailer;
	private caddyfileMtime = -1;
	private loops = new Map<string, Loop>();
	private stopped = false;
	readonly connectHost: string;
	private probeTimeoutMs: number;

	constructor(
		private db: Db,
		private cfg: Config,
		private now: () => number = Date.now
	) {
		this.connectHost = new URL(cfg.adminUrl).hostname;
		this.probeTimeoutMs = probeTimeout(cfg.probeIntervalMs);
		this.states = loadStates(db);
		const siteFor = (host: string) => this.matcher.match(host);
		this.metrics = new MetricsRollup(siteFor);
		this.logs = new LogRollup(siteFor);
		const saved = getSetting(db, TAIL_KEY);
		this.tailer = new FileTailer(cfg.logPath, saved ? (JSON.parse(saved) as TailPosition) : undefined);
		this.status = {
			startedAt: now(),
			caddyfile: { ...job(), sites: 0 },
			probes: { ...job(), intervalMs: cfg.probeIntervalMs },
			metrics: { ...job(), intervalMs: cfg.scrapeIntervalMs, perHost: false },
			logs: { ...job(), path: cfg.logPath, found: false, lastEntry: null },
			certs: { ...job(), count: 0 }
		};
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

	/** Probes every site through Caddy and every upstream directly, once each, and records state flips. */
	async probeAll(): Promise<void> {
		const st = this.status.probes;
		st.lastRun = this.now();
		this.refreshSites();
		const siteResults = new Map<string, ProbeResult>();
		const upstreamResults = new Map<string, ProbeResult>();
		const siteJobs = this.sites.flatMap((s) => {
			const t = probeTarget(s.addresses, this.connectHost);
			return t ? [{ id: s.id, t }] : [];
		});
		const upstreams = [...new Set(this.sites.flatMap((s) => s.upstreams.map((u) => u.address)))];
		const jobs: (() => Promise<void>)[] = [
			...siteJobs.map(({ id, t }) => async () => {
				siteResults.set(id, await this.withRetry(() => probeSite(t, this.probeTimeoutMs)));
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
		this.db.transaction(() => {
			for (const s of this.sites) {
				const own = siteResults.get(s.id);
				if (own)
					rows.push({
						siteId: s.id,
						target: probeTarget(s.addresses, this.connectHost)!.url,
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
			}
			insertProbes(this.db, rows);
		})();
		st.lastOk = ts;
		st.error = null;
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

	tailLogs(): void {
		const st = this.status.logs;
		st.lastRun = this.now();
		try {
			const before = this.tailer.position;
			const lines = this.tailer.read();
			st.found = this.tailer.position !== undefined;
			for (const line of lines) {
				const e = parseAccessLine(line);
				if (!e) continue;
				this.logs.add(e);
				st.lastEntry = Math.max(st.lastEntry ?? 0, e.ts);
			}
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
	}

	prune(): void {
		prune(this.db, this.cfg.retentionDays, this.now());
	}

	private schedule(loop: Loop, delay: number): void {
		const t = setTimeout(() => void this.tick(loop), delay);
		t.unref();
		loop.timer = t;
	}

	private async tick(loop: Loop): Promise<void> {
		loop.timer = undefined;
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
	intervalOf(name: 'probes' | 'metrics' | 'logs' | 'certs' | 'prune'): number | undefined {
		return this.loops.get(name)?.ms;
	}

	/**
	 * Apply a changed config while running (settings service, plan §2.2): the probe and scrape timers are
	 * re-armed, and retention is read at the next prune. Environment-only fields (paths, admin URL) are not
	 * taken from `next`; they cannot change while the process runs.
	 */
	reconfigure(next: Config): void {
		this.cfg = {
			...this.cfg,
			probeIntervalMs: next.probeIntervalMs,
			scrapeIntervalMs: next.scrapeIntervalMs,
			retentionDays: next.retentionDays
		};
		this.probeTimeoutMs = probeTimeout(next.probeIntervalMs);
		this.status.probes.intervalMs = next.probeIntervalMs;
		this.status.metrics.intervalMs = next.scrapeIntervalMs;
		this.rearm('probes', next.probeIntervalMs);
		this.rearm('metrics', next.scrapeIntervalMs);
	}

	start(): void {
		this.refreshSites();
		this.every('probes', this.cfg.probeIntervalMs, () => this.probeAll());
		this.every('metrics', this.cfg.scrapeIntervalMs, () => this.scrapeMetrics());
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
