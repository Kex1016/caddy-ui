import {
	PORKBUN_NAMESERVERS,
	type AccountBalance,
	type ApiError,
	type AutoRenewResult,
	type Cached,
	type DomainSummary,
	type SpendSettings
} from '$lib/api/porkbun';

/**
 * Shapes and pure helpers for the domain list and the Overview tab (workstream P1, docs/porkbun-plan.md §5).
 * Client-safe: the pages, the `/api/porkbun/domains*` routes and the tests share these. The server side that
 * fills them is `data.server.ts` next to this file.
 */

/** A read that may fail on its own without taking the rest of the page down with it. */
export type Part<T> = ({ ok: true } & Cached<T>) | { ok: false; error: ApiError };

/** One row of the domain list: Porkbun's summary plus the list price to renew it for a year. */
export type DomainRow = DomainSummary & {
	/** US dollars as Porkbun prints them ("11.08"), or null when the TLD is not in the price list. */
	renewal: string | null;
};

/** `GET /api/porkbun/domains`. The price list failing leaves `renewal` null and says why in `pricingError`. */
export type DomainList = Cached<DomainRow[]> & { pricingError: ApiError | null };

/**
 * What the list page draws a row from: a `DomainRow` without the fields it does not show, because the page
 * carries every row of the account (1,000 or more) in its data and each byte counts against the budget.
 */
export type ListRow = Omit<DomainRow, 'createDate' | 'tld'>;

export function toListRow({ createDate: _c, tld: _t, ...row }: DomainRow): ListRow {
	return row;
}

export type NameserverSummary = {
	/** porkbun: exactly Porkbun's defaults. custom: none of them. mixed: some. none: Porkbun listed none. */
	kind: 'porkbun' | 'custom' | 'mixed' | 'none';
	ns: string[];
};

export type DnsCounts = { total: number; byType: Record<string, number>; cloudflare: boolean };
export type HistoryCounts = { total: number; latest: string | null };

/** `GET /api/porkbun/domains/:d`: the Overview tab. Every part is read and cached on its own. */
export type DomainOverview = {
	/** From `/domain/get`, so every flag on the tab is the registry's own answer, not the list's. */
	detail: Part<DomainSummary>;
	renewal: string | null;
	pricingError: ApiError | null;
	nameservers: Part<NameserverSummary>;
	dns: Part<DnsCounts>;
	history: Part<HistoryCounts>;
	forwards: Part<number>;
	glue: Part<number>;
	dnssec: Part<number>;
};

/** `GET /api/porkbun/account`. Either half can be refused by a key without the permission for it. */
export type AccountInfo = { balance: Part<AccountBalance>; spend: Part<SpendSettings> };

/** `PUT /api/porkbun/auto-renew`: what Porkbun said for each domain, in the order asked. */
export type BulkAutoRenew = { results: AutoRenewResult[]; warnings: string[]; auditIds: number[] };

/** Domains that expire within this many days count as "expiring soon". */
export const EXPIRING_SOON_DAYS = 30;

/** Rows per page of the domain list. Sorting and filtering run over every row; only drawing is paged. */
export const PAGE_SIZE = 100;

const DAY_MS = 86_400_000;

/** Whole days from `now` until an ISO date, negative once it has passed. null for a missing date. */
export function daysUntil(iso: string, now: number): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	return Math.floor((t - now) / DAY_MS);
}

export type ExpiryState = 'expired' | 'soon' | 'ok' | 'unknown';

export function expiryState(days: number | null): ExpiryState {
	if (days === null) return 'unknown';
	if (days < 0) return 'expired';
	if (days <= EXPIRING_SOON_DAYS) return 'soon';
	return 'ok';
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "today", "in 12 days", "in 11 months", "in 2 years", "3 days ago". */
export function formatCountdown(days: number | null): string {
	if (days === null) return 'unknown';
	if (days === 0) return 'today';
	const n = Math.abs(days);
	let span: string;
	if (n < 60) span = plural(n, 'day');
	else if (n < 730) span = plural(Math.floor(n / 30.4375), 'month');
	else span = plural(Math.floor(n / 365.25), 'year');
	return days > 0 ? `in ${span}` : `${span} ago`;
}

/** Whether a domain uses Porkbun's own nameservers, someone else's, or a mix. */
export function summariseNameservers(ns: readonly string[]): NameserverSummary {
	const list = [...ns];
	if (list.length === 0) return { kind: 'none', ns: list };
	const ours = list.filter((n) => PORKBUN_NAMESERVERS.includes(n)).length;
	const kind =
		ours === 0
			? 'custom'
			: ours === list.length && list.length === PORKBUN_NAMESERVERS.length
				? 'porkbun'
				: 'mixed';
	return { kind, ns: list };
}

/** "4 A, 2 MX, 1 TXT": the commonest types first, the rest summed. */
export function describeTypes(byType: Record<string, number>, max = 4): string {
	const entries = Object.entries(byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const head = entries.slice(0, max).map(([type, n]) => `${n} ${type}`);
	const rest = entries.slice(max).reduce((sum, [, n]) => sum + n, 0);
	return rest > 0 ? `${head.join(', ')}, ${rest} other` : head.join(', ');
}

export type DomainFilter = 'all' | 'soon' | 'renew-off' | 'renew-on' | 'api-off';

export const DOMAIN_FILTERS: readonly { id: DomainFilter; label: string }[] = [
	{ id: 'all', label: 'All' },
	{ id: 'soon', label: 'Expiring soon' },
	{ id: 'renew-off', label: 'Auto-renew off' },
	{ id: 'renew-on', label: 'Auto-renew on' },
	{ id: 'api-off', label: 'API access off' }
];

export function isDomainFilter(v: string | null): v is DomainFilter {
	return DOMAIN_FILTERS.some((f) => f.id === v);
}

export function matchesFilter(row: ListRow, filter: DomainFilter, now: number): boolean {
	switch (filter) {
		case 'all':
			return true;
		case 'soon': {
			const state = expiryState(daysUntil(row.expireDate, now));
			return state === 'soon' || state === 'expired';
		}
		case 'renew-off':
			return !row.autoRenew;
		case 'renew-on':
			return row.autoRenew;
		case 'api-off':
			return !row.apiAccess;
	}
}

/** Case-insensitive match on the name and the label titles. */
export function matchesQuery(row: ListRow, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q === '') return true;
	return row.domain.includes(q) || row.labels.some((l) => l.title.toLowerCase().includes(q));
}

export type DomainSortKey = 'domain' | 'expires' | 'renewal';
export type DomainSort = { key: DomainSortKey; dir: 'asc' | 'desc' };

/** Missing dates and prices sort last in both directions; ties fall back to the name. */
export function sortDomains<T extends ListRow>(rows: readonly T[], sort: DomainSort): T[] {
	const sign = sort.dir === 'asc' ? 1 : -1;
	const value = (r: T): number | string | null => {
		if (sort.key === 'domain') return r.domain;
		if (sort.key === 'expires') {
			const t = Date.parse(r.expireDate);
			return Number.isNaN(t) ? null : t;
		}
		const p = r.renewal === null ? NaN : Number.parseFloat(r.renewal);
		return Number.isNaN(p) ? null : p;
	};
	const keyed = rows.map((r) => ({ r, v: value(r) }));
	keyed.sort((a, b) => {
		if (a.v === null || b.v === null) {
			if (a.v === b.v) return a.r.domain.localeCompare(b.r.domain);
			return a.v === null ? 1 : -1;
		}
		const c = typeof a.v === 'string' ? a.v.localeCompare(b.v as string) : (a.v as number) - (b.v as number);
		return c !== 0 ? c * sign : a.r.domain.localeCompare(b.r.domain);
	});
	return keyed.map((k) => k.r);
}

/** "$11.08". Porkbun prints dollars without the sign. */
export function formatUsd(amount: string | null): string {
	if (amount === null || amount === '') return '—';
	const n = Number.parseFloat(amount);
	return Number.isNaN(n) ? amount : `$${n.toFixed(2)}`;
}

/** "$25.00" from cents. */
export function formatCents(cents: number | null): string {
	return cents === null ? '—' : `$${(cents / 100).toFixed(2)}`;
}
