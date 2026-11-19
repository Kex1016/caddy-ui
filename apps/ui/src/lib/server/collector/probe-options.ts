import type { Db } from '../db';

/**
 * Per-site probe options (docs/settings-and-perf-plan.md §3, monitoring thresholds), kept in `probe_options`
 * (migration 6) by site id. A site without a row is probed as before: its own address at the path of the site
 * block, and up unless Caddy answers 502, 503 or 504.
 */
export type ProbeOptions = {
	/** Do not probe the site or its upstreams; its status shows as unknown. */
	skip: boolean;
	/** Probe this path (and query) instead of the site block's own, for example `/health`. */
	path: string | null;
	/** Statuses that count as up on top of the usual rule, for example 503 for a maintenance page. */
	upStatuses: number[];
};

export const NO_OPTIONS: ProbeOptions = { skip: false, path: null, upStatuses: [] };

export class ProbeOptionsError extends Error {
	constructor(
		readonly field: 'skip' | 'path' | 'upStatuses' | 'siteId',
		message: string
	) {
		super(message);
		this.name = 'ProbeOptionsError';
	}
}

const isDefault = (o: ProbeOptions) => !o.skip && o.path === null && o.upStatuses.length === 0;

/** A path to probe: starts with `/`, no spaces or control characters, at most 512 characters. Empty is none. */
export function parsePath(raw: string): string | null {
	const v = raw.trim();
	if (v === '') return null;
	if (!v.startsWith('/') || v.startsWith('//')) {
		throw new ProbeOptionsError('path', 'The path must start with a single /, for example /health');
	}
	// eslint-disable-next-line no-control-regex
	if (v.length > 512 || /[\s\u0000-\u001f\u007f#]/.test(v)) {
		throw new ProbeOptionsError('path', 'The path must be at most 512 characters, with no spaces or #');
	}
	return v;
}

/** `503, 401` → [401, 503]. Each a status from 100 to 599. Empty is none. */
export function parseStatuses(raw: string): number[] {
	const parts = raw
		.split(/[\s,]+/)
		.map((p) => p.trim())
		.filter(Boolean);
	const out = new Set<number>();
	for (const p of parts) {
		if (!/^\d{3}$/.test(p) || Number(p) < 100 || Number(p) > 599) {
			throw new ProbeOptionsError(
				'upStatuses',
				`"${p}" is not an HTTP status; use numbers such as 503 or 401`
			);
		}
		out.add(Number(p));
	}
	if (out.size > 20) throw new ProbeOptionsError('upStatuses', 'At most 20 statuses');
	return [...out].sort((a, b) => a - b);
}

/** Options from form fields. Throws `ProbeOptionsError` naming the field. */
export function parseProbeOptions(input: {
	skip: unknown;
	path: unknown;
	upStatuses: unknown;
}): ProbeOptions {
	const skip = input.skip === true || input.skip === 'on' || input.skip === 'true';
	const path = parsePath(typeof input.path === 'string' ? input.path : '');
	const upStatuses = parseStatuses(typeof input.upStatuses === 'string' ? input.upStatuses : '');
	return { skip, path, upStatuses };
}

/** One short line for the settings log and the page: `skipped · /health · also up: 503`, or `as usual`. */
export function describeOptions(o: ProbeOptions): string {
	if (isDefault(o)) return 'as usual';
	const parts: string[] = [];
	if (o.skip) parts.push('not probed');
	if (o.path) parts.push(`path ${o.path}`);
	if (o.upStatuses.length) parts.push(`also up: ${o.upStatuses.join(', ')}`);
	return parts.join(' · ');
}

type Row = { site_id: string; skip: number; path: string | null; up_statuses: string | null };

export function loadProbeOptions(db: Db): Map<string, ProbeOptions> {
	const rows = db.prepare(`SELECT site_id, skip, path, up_statuses FROM probe_options`).all() as Row[];
	const out = new Map<string, ProbeOptions>();
	for (const r of rows) {
		let upStatuses: number[] = [];
		try {
			upStatuses = r.up_statuses ? parseStatuses(r.up_statuses) : [];
		} catch {
			// A row a newer build wrote in another form: keep the rest of it.
		}
		out.set(r.site_id, { skip: r.skip === 1, path: r.path, upStatuses });
	}
	return out;
}

/**
 * Save one site's options (removing the row when they are all back to the defaults) and log the change in
 * `settings_log` under `probe:<site address>`, so Recent changes on the Settings page lists it. Returns whether
 * anything changed.
 */
export function saveProbeOptions(
	db: Db,
	site: { id: string; label: string },
	next: ProbeOptions,
	author: string,
	now: number
): boolean {
	const prev = loadProbeOptions(db).get(site.id) ?? NO_OPTIONS;
	const before = describeOptions(prev);
	const after = describeOptions(next);
	if (before === after) return false;
	db.transaction(() => {
		if (isDefault(next)) db.prepare(`DELETE FROM probe_options WHERE site_id = ?`).run(site.id);
		else
			db.prepare(
				`INSERT INTO probe_options (site_id, skip, path, up_statuses, updated_at, author) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (site_id) DO UPDATE SET skip = excluded.skip, path = excluded.path,
				 up_statuses = excluded.up_statuses, updated_at = excluded.updated_at, author = excluded.author`
			).run(
				site.id,
				next.skip ? 1 : 0,
				next.path,
				next.upStatuses.length ? next.upStatuses.join(',') : null,
				now,
				author
			);
		db.prepare(`INSERT INTO settings_log (ts, author, key, old_value, new_value) VALUES (?, ?, ?, ?, ?)`).run(
			now,
			author,
			`probe:${site.label}`,
			before,
			after
		);
	})();
	return true;
}

/** The target URL with its path (and query) replaced. */
export function withPath(url: string, path: string | null): string {
	if (!path) return url;
	const u = new URL(url);
	const q = path.indexOf('?');
	u.pathname = q < 0 ? path : path.slice(0, q);
	u.search = q < 0 ? '' : path.slice(q);
	return u.toString();
}
