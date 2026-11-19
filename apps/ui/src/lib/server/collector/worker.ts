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
	logs: JobStatus & { path: string; found: boolean; lastEntry: number | null; lagBytes: number };
	certs: JobStatus & { count: number };
	upstreams: JobStatus;
};

/** One upstream as Caddy's `/reverse_proxy/upstreams` reports it (passive health). */
export type LiveUpstream = { address: string; num_requests: number; fails: number };

/** The last answer from `/reverse_proxy/upstreams`: `data` is null when the admin API did not answer. */
export type LiveUpstreams = { at: number; data: Map<string, LiveUpstream> | null };

/** What changed, for whoever keeps a snapshot of the read side (snapshot.ts). */
export type CollectorEvent = 'probes' | 'sites' | 'upstreams' | 'certs';

const TAIL_KEY = 'collector.log_position';
const LOG_EVERY_MS = 5_000;
/** The log tail is read and parsed this much at a time, yielding between slices so requests get through. */
const LOG_SLICE_BYTES = 1024 * 1024;
const LOG_SLICES_PER_TICK = 8;
const HOURLY = 3_600_000;
const PROBE_CONCURRENCY = 16;
const RETRY_DELAY_MS = 1_000;

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
	private states: Map<string, { state: State; since: number }>;
	private listeners: ((e: CollectorEvent) => void)[] = [];
	private metrics: MetricsRollup;
	private logs: LogRollup;
	private tailer: FileTailer;
	private caddyfileMtime = -1;
	private timers: NodeJS.Timeout[] = [];
	private stopped = false;
	readonly connectHost: string;
	private probeTimeoutMs: number;

	constructor(
		private db: Db,
		private cfg: Config,
		private now: () => number = Date.now
	) {
		this.connectHost = new URL(cfg.adminUrl).hostname;
		this.probeTimeoutMs = Math.min(10_000, Math.max(2_000, cfg.probeIntervalMs / 3));
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
			logs: { ...job(), path: cfg.logPath, found: false, lastEntry: null, lagBytes: 0 },
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
					this.logs.add(e);
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
	async prune(): Promise<void> {
		await pruneInBatches(this.db, this.cfg.retentionDays, this.now());
	}

	private every(ms: number, fn: () => unknown, delay = 0): void {
		const tick = async () => {
			if (this.stopped) return;
			try {
				await fn();
			} catch (err) {
				console.error('caddy-ui collector:', err);
			}
			if (this.stopped) return;
			const t = setTimeout(tick, ms);
			t.unref();
			this.timers.push(t);
		};
		const t = setTimeout(tick, delay);
		t.unref();
		this.timers.push(t);
	}

	start(): void {
		this.refreshSites();
		this.every(this.cfg.probeIntervalMs, () => this.probeAll());
		this.every(this.cfg.scrapeIntervalMs, () => this.scrapeMetrics());
		this.every(this.cfg.scrapeIntervalMs, () => this.pollUpstreams());
		this.every(LOG_EVERY_MS, () => this.tailLogs());
		this.every(HOURLY, () => this.scanCerts());
		this.every(HOURLY, () => this.prune(), 60_000);
	}

	/** Stops the timers and writes what is buffered for the open minute. */
	stop(): void {
		this.stopped = true;
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
		try {
			insertMetricRows(this.db, this.metrics.flush());
			upsertLogMinutes(this.db, this.logs.take(this.now(), true));
		} catch {
			// The database may already be closed on shutdown.
		}
	}
}
