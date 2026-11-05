import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

/** One access-log entry, reduced to what the rollups need. */
export type AccessEntry = {
	ts: number;
	host: string;
	path: string;
	status: number;
	durationMs: number;
	bytes: number;
	ip: string;
};

/**
 * Parses one line of Caddy's JSON access log (`log` directive, `format json`, the default). Returns undefined
 * for lines that are not access entries, such as other loggers sharing the file.
 */
export function parseAccessLine(line: string): AccessEntry | undefined {
	if (!line.startsWith('{')) return undefined;
	let j: unknown;
	try {
		j = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!j || typeof j !== 'object') return undefined;
	const o = j as Record<string, unknown>;
	const req = o.request as Record<string, unknown> | undefined;
	if (!req || typeof req !== 'object' || typeof o.status !== 'number') return undefined;
	const ts = typeof o.ts === 'number' ? o.ts * 1000 : Date.parse(String(o.ts));
	if (!Number.isFinite(ts)) return undefined;
	const uri = typeof req.uri === 'string' ? req.uri : '/';
	const q = uri.indexOf('?');
	const ip =
		(typeof req.client_ip === 'string' && req.client_ip) ||
		(typeof req.remote_ip === 'string' && req.remote_ip) ||
		'';
	return {
		ts,
		host: typeof req.host === 'string' ? req.host : '',
		path: q >= 0 ? uri.slice(0, q) : uri,
		status: o.status,
		// Caddy writes duration in seconds as a float (the default duration_format).
		durationMs: typeof o.duration === 'number' ? o.duration * 1000 : 0,
		bytes: typeof o.size === 'number' ? o.size : 0,
		ip
	};
}

export type LogMinuteRow = {
	siteId: string;
	minute: number;
	requests: number;
	errors4xx: number;
	errors5xx: number;
	bytesOut: number;
	p50Ms: number | null;
	p95Ms: number | null;
	topPaths: [string, number][];
	topIps: [string, number][];
};

type Bucket = {
	requests: number;
	e4: number;
	e5: number;
	bytes: number;
	durations: number[];
	paths: Map<string, number>;
	ips: Map<string, number>;
};

const MINUTE = 60_000;
const TOP_N = 10;
/** Caps per-minute memory on a flood: past this many distinct keys, new ones are counted as "(other)". */
const MAX_KEYS = 5000;

export function percentile(sorted: number[], q: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return Math.round((sorted[idx] as number) * 10) / 10;
}

function top(m: Map<string, number>): [string, number][] {
	return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_N);
}

function bump(m: Map<string, number>, key: string) {
	if (!m.has(key) && m.size >= MAX_KEYS) key = '(other)';
	m.set(key, (m.get(key) ?? 0) + 1);
}

/**
 * Groups entries into (site, minute) buckets. Site '*' is the whole server and '' a host no site block
 * serves. Minutes are handed out once they are `graceMs` in the past, so late lines still land.
 */
export class LogRollup {
	private buckets = new Map<string, Bucket>();

	constructor(
		private siteFor: (host: string) => string | undefined,
		private graceMs = 15_000
	) {}

	add(e: AccessEntry) {
		const minute = Math.floor(e.ts / MINUTE) * MINUTE;
		const site = this.siteFor(e.host) ?? '';
		for (const id of site === '' ? ['*', ''] : ['*', site]) {
			const key = `${id}|${minute}`;
			let b = this.buckets.get(key);
			if (!b) {
				b = { requests: 0, e4: 0, e5: 0, bytes: 0, durations: [], paths: new Map(), ips: new Map() };
				this.buckets.set(key, b);
			}
			b.requests++;
			if (e.status >= 400 && e.status < 500) b.e4++;
			if (e.status >= 500) b.e5++;
			b.bytes += e.bytes;
			b.durations.push(e.durationMs);
			bump(b.paths, e.path);
			if (e.ip) bump(b.ips, e.ip);
		}
	}

	/** Closed minutes, removed from memory. Pass `all` on shutdown. */
	take(now: number, all = false): LogMinuteRow[] {
		const out: LogMinuteRow[] = [];
		for (const [key, b] of this.buckets) {
			const cut = key.lastIndexOf('|');
			const minute = Number(key.slice(cut + 1));
			if (!all && minute + MINUTE + this.graceMs > now) continue;
			const sorted = b.durations.sort((x, y) => x - y);
			out.push({
				siteId: key.slice(0, cut),
				minute,
				requests: b.requests,
				errors4xx: b.e4,
				errors5xx: b.e5,
				bytesOut: b.bytes,
				p50Ms: percentile(sorted, 0.5),
				p95Ms: percentile(sorted, 0.95),
				topPaths: top(b.paths),
				topIps: top(b.ips)
			});
			this.buckets.delete(key);
		}
		return out;
	}
}

export type TailPosition = { ino: number; offset: number };

/**
 * Reads new lines from a growing file. Notices rotation (new inode, or the file got shorter) and starts the
 * new file from the top. A missing file is not an error: logging may simply be off.
 */
export class FileTailer {
	constructor(
		private path: string,
		public position: TailPosition | undefined
	) {}

	/**
	 * Returns complete lines appended since the last call. A file that already exists the first time it is seen
	 * is read from its end, so years of history are not replayed into the current minute.
	 */
	read(maxBytes = 8 * 1024 * 1024): string[] {
		let st;
		try {
			st = statSync(this.path);
		} catch {
			// Missing: when it appears it is a new file, so it is read from the top.
			this.position ??= { ino: -1, offset: 0 };
			return [];
		}
		if (!this.position) {
			this.position = { ino: st.ino, offset: st.size };
			return [];
		}
		if (st.ino !== this.position.ino || st.size < this.position.offset) {
			this.position = { ino: st.ino, offset: 0 };
		}
		if (st.size === this.position.offset) return [];
		const fd = openSync(this.path, 'r');
		try {
			const ino = fstatSync(fd).ino;
			if (ino !== this.position.ino) this.position = { ino, offset: 0 };
			const len = Math.min(maxBytes, st.size - this.position.offset);
			const buf = Buffer.alloc(len);
			const got = readSync(fd, buf, 0, len, this.position.offset);
			// Stop at the last newline; a half-written line is read again, whole, next time.
			const end = buf.subarray(0, got).lastIndexOf(0x0a) + 1;
			if (end === 0) {
				// One line longer than maxBytes: skip it rather than stall forever.
				if (got === maxBytes) this.position = { ino, offset: this.position.offset + got };
				return [];
			}
			this.position = { ino, offset: this.position.offset + end };
			return buf
				.subarray(0, end)
				.toString('utf8')
				.split('\n')
				.filter((l) => l.trim() !== '');
		} finally {
			closeSync(fd);
		}
	}
}
