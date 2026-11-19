/**
 * Per-request step timings (docs/settings-and-perf-plan.md §1.3 A). Every request gets one in `locals.timing`;
 * loads and API handlers add their steps, and `hooks.server.ts` sends them as a `Server-Timing` header and logs
 * a line when an instrumented request took over `SLOW_MS`, streamed parts included.
 */

export type Step = { name: string; dur?: number; desc?: string };

export const SLOW_MS = 500;
const KEEP_SLOW = 20;

export type SlowLoad = { at: number; path: string; totalMs: number; steps: Step[] };

/** The slowest recent loads over `SLOW_MS`, newest first, for Diagnostics (S3). */
const slow: SlowLoad[] = [];
export function recentSlowLoads(): readonly SlowLoad[] {
	return slow;
}

const round = (ms: number) => Math.round(ms * 10) / 10;
const token = (name: string) => name.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, '_');
const quoted = (desc: string) => `"${desc.replace(/["\\]/g, '')}"`;

export class Timing {
	readonly steps: Step[] = [];
	private readonly start = performance.now();
	private pending: Promise<unknown>[] = [];

	/** Runs `fn` and records how long it took under `name`. */
	measure<T>(name: string, fn: () => T, desc?: string): T {
		const t = performance.now();
		try {
			return fn();
		} finally {
			this.add(name, performance.now() - t, desc);
		}
	}

	add(name: string, dur?: number, desc?: string): void {
		this.steps.push({ name, ...(dur === undefined ? {} : { dur: round(dur) }), ...(desc ? { desc } : {}) });
	}

	/** Steps measured elsewhere (the collector's snapshot build), tagged so the header says where they ran. */
	addAll(steps: readonly Step[], desc?: string): void {
		for (const s of steps) this.add(s.name, s.dur, desc ?? s.desc);
	}

	/**
	 * Runs `fn` after the current response has had a chance to go out, so a page can send its shell first and
	 * stream this part in. Its time is recorded, and it counts towards the slow-load log line.
	 */
	defer<T>(name: string, fn: () => T): Promise<T> {
		const p = new Promise<T>((resolve, reject) => {
			setImmediate(() => {
				try {
					resolve(this.measure(name, fn, 'streamed'));
				} catch (err) {
					reject(err);
				}
			});
		});
		this.pending.push(p.catch(() => undefined));
		return p;
	}

	get instrumented(): boolean {
		return this.steps.length > 0 || this.pending.length > 0;
	}

	elapsed(): number {
		return performance.now() - this.start;
	}

	/** The `Server-Timing` value: every step so far, then `total` (time until the response started). */
	header(): string {
		return [...this.steps, { name: 'total', dur: round(this.elapsed()) }]
			.map((s) => {
				let v = token(s.name);
				if (s.dur !== undefined) v += `;dur=${s.dur}`;
				if (s.desc) v += `;desc=${quoted(s.desc)}`;
				return v;
			})
			.join(', ');
	}

	/** Resolves once every deferred part has settled. */
	async settled(): Promise<void> {
		while (this.pending.length > 0) {
			const batch = this.pending;
			this.pending = [];
			await Promise.all(batch);
		}
	}

	/** Logs and remembers the request when it took over `SLOW_MS`, streamed parts included. */
	async report(path: string, log: (line: string) => void = console.warn): Promise<void> {
		await this.settled();
		const totalMs = round(this.elapsed());
		if (!this.instrumented || totalMs <= SLOW_MS) return;
		const parts = this.steps.map((s) => `${s.name}=${s.dur ?? '-'}${s.desc ? `(${s.desc})` : ''}`).join(' ');
		log(`caddy-ui: slow load ${path} ${totalMs} ms: ${parts}`);
		slow.unshift({ at: Date.now(), path, totalMs, steps: [...this.steps] });
		slow.length = Math.min(slow.length, KEEP_SLOW);
	}
}
