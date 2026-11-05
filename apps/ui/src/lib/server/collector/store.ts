import type { Db } from '../db';
import type { CertInfo } from './certs';
import type { LogMinuteRow } from './logs';
import type { MetricRow } from './metrics';
import type { ProbeResult } from './probe';
import type { SiteBlock } from './sites';

/** Collector writes. Reads for the API live in `queries.ts`. Every function takes the db so tests can pass one. */

export type State = 'up' | 'down' | 'unknown';

export function syncSites(db: Db, sites: SiteBlock[], now: number): void {
	const upsert = db.prepare(
		`INSERT INTO sites (id, addresses_json, first_seen, last_seen, removed_at) VALUES (?, ?, ?, ?, NULL)
		 ON CONFLICT (id) DO UPDATE SET addresses_json = excluded.addresses_json, last_seen = excluded.last_seen,
		 removed_at = NULL`
	);
	const remove = db.prepare(
		`UPDATE sites SET removed_at = ? WHERE removed_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))`
	);
	db.transaction(() => {
		for (const s of sites) upsert.run(s.id, JSON.stringify(s.addresses), now, now);
		remove.run(now, JSON.stringify(sites.map((s) => s.id)));
	})();
}

export type ProbeRow = {
	siteId: string;
	target: string;
	kind: 'site' | 'upstream';
	ts: number;
} & ProbeResult;

export function insertProbes(db: Db, rows: ProbeRow[]): void {
	const ins = db.prepare(
		`INSERT INTO probes (site_id, target, kind, ts, ok, latency_ms, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	db.transaction(() => {
		for (const r of rows)
			ins.run(r.siteId, r.target, r.kind, r.ts, r.ok ? 1 : 0, r.latencyMs, r.status, r.error);
	})();
}

/** Latest known state per (site, target), from the last state change. target '' is the site itself. */
export function loadStates(db: Db): Map<string, { state: State; since: number }> {
	const rows = db
		.prepare(
			`SELECT site_id, target, "to" AS state, ts FROM state_changes s
			 WHERE ts = (SELECT MAX(ts) FROM state_changes t WHERE t.site_id = s.site_id AND t.target = s.target)`
		)
		.all() as { site_id: string; target: string; state: State; ts: number }[];
	return new Map(rows.map((r) => [`${r.site_id}|${r.target}`, { state: r.state, since: r.ts }]));
}

/** Records a flip when `to` differs from the known state. Returns true when it did. */
export function recordState(
	db: Db,
	known: Map<string, { state: State; since: number }>,
	siteId: string,
	target: string,
	to: State,
	ts: number
): boolean {
	const key = `${siteId}|${target}`;
	const from = known.get(key)?.state ?? 'unknown';
	if (from === to && known.has(key)) return false;
	db.prepare(`INSERT INTO state_changes (site_id, ts, "from", "to", target) VALUES (?, ?, ?, ?, ?)`).run(
		siteId,
		ts,
		from,
		to,
		target
	);
	known.set(key, { state: to, since: ts });
	return true;
}

export function insertMetricRows(db: Db, rows: MetricRow[]): void {
	if (rows.length === 0) return;
	const ins = db.prepare(`INSERT INTO metric_samples (ts, name, labels_json, value) VALUES (?, ?, ?, ?)`);
	db.transaction(() => {
		for (const r of rows) ins.run(r.ts, r.name, JSON.stringify(r.labels), r.value);
	})();
}

function mergeTop(a: [string, number][], b: [string, number][]): [string, number][] {
	const m = new Map(a);
	for (const [k, v] of b) m.set(k, (m.get(k) ?? 0) + v);
	return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);
}

/**
 * Writes minute rollups. A minute that already exists (the process restarted mid-minute) is merged: counts
 * add up, percentiles become a request-weighted mean, top lists are summed.
 */
export function upsertLogMinutes(db: Db, rows: LogMinuteRow[]): void {
	if (rows.length === 0) return;
	const get = db.prepare(`SELECT * FROM log_minutes WHERE site_id = ? AND minute = ?`);
	const put = db.prepare(
		`INSERT OR REPLACE INTO log_minutes (site_id, minute, requests, errors_4xx, errors_5xx, bytes_out, p50_ms,
		 p95_ms, top_paths_json, top_ips_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	db.transaction(() => {
		for (const r of rows) {
			const old = get.get(r.siteId, r.minute) as
				| {
						requests: number;
						errors_4xx: number;
						errors_5xx: number;
						bytes_out: number;
						p50_ms: number | null;
						p95_ms: number | null;
						top_paths_json: string;
						top_ips_json: string;
				  }
				| undefined;
			let row = r;
			if (old) {
				const n = old.requests + r.requests;
				const w = (a: number | null, b: number | null) =>
					a === null ? b : b === null ? a : Math.round(((a * old.requests + b * r.requests) / n) * 10) / 10;
				row = {
					...r,
					requests: n,
					errors4xx: old.errors_4xx + r.errors4xx,
					errors5xx: old.errors_5xx + r.errors5xx,
					bytesOut: old.bytes_out + r.bytesOut,
					p50Ms: w(old.p50_ms, r.p50Ms),
					p95Ms: w(old.p95_ms, r.p95Ms),
					topPaths: mergeTop(JSON.parse(old.top_paths_json), r.topPaths),
					topIps: mergeTop(JSON.parse(old.top_ips_json), r.topIps)
				};
			}
			put.run(
				row.siteId,
				row.minute,
				row.requests,
				row.errors4xx,
				row.errors5xx,
				row.bytesOut,
				row.p50Ms,
				row.p95Ms,
				JSON.stringify(row.topPaths),
				JSON.stringify(row.topIps)
			);
		}
	})();
}

export function replaceCerts(db: Db, certs: CertInfo[], now: number): void {
	const put = db.prepare(
		`INSERT INTO certs (host, not_after, issuer, seen_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (host) DO UPDATE SET not_after = excluded.not_after, issuer = excluded.issuer, seen_at = excluded.seen_at`
	);
	db.transaction(() => {
		for (const c of certs) put.run(c.host, c.notAfter, c.issuer, now);
	})();
}

/**
 * Drops raw rows older than the retention window: probes and metric samples. Minute rollups of the access
 * log, state changes and certificates are kept (PLAN.md §3.2: "minute rollups kept forever").
 */
export function prune(db: Db, retentionDays: number, now: number): { probes: number; metrics: number } {
	const cutoff = now - retentionDays * 86_400_000;
	const probes = db.prepare(`DELETE FROM probes WHERE ts < ?`).run(cutoff).changes;
	const metrics = db.prepare(`DELETE FROM metric_samples WHERE ts < ?`).run(cutoff).changes;
	return { probes, metrics };
}

export function getSetting(db: Db, key: string): string | undefined {
	const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
		{ value: string } | undefined;
	return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
	db.prepare(
		`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`
	).run(key, value);
}
