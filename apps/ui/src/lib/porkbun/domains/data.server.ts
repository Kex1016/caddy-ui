import { error } from '@sveltejs/kit';
import type { ApiError, AutoRenewResult, Cached, DomainSummary, WriteResult } from '$lib/api/porkbun';
import {
	DOMAINS_KEY,
	cached,
	listDomains,
	porkbun,
	requireDomain,
	toApiError,
	write
} from '$lib/server/porkbun';
import {
	summariseNameservers,
	type AccountInfo,
	type BulkAutoRenew,
	type DnsCounts,
	type DomainList,
	type DomainOverview,
	type HistoryCounts,
	type NameserverSummary,
	type Part
} from './index';

/**
 * The server half of workstream P1: the reads behind the domain list, the Overview tab and the account
 * figures, and the auto-renew write. The `/api/porkbun/domains*`, `/api/porkbun/auto-renew` and
 * `/api/porkbun/account` routes and the two pages' loads all call these, so they answer the same.
 *
 * Cache keys this file adds (README in `$lib/server/porkbun`): `_account:pricing`, `_account:balance`,
 * `_account:spend`, and per domain `<d>:domain` plus `<d>:<area>:overview` under the area the owning tab
 * caches, so a write on that tab, which drops `<d>:<area>` or all of `<d>`, drops the count here too. The
 * overview keeps counts only under those keys, never another tab's data. The nameservers are the exception:
 * they are read through P3's own key, `<d>:ns`, with P3's loader (`pb.ns.get`), and summarised after.
 */

/** Run a cached read, turning a Porkbun refusal or an outage into a `Part` the page can show in place. */
async function part<T>(read: () => Promise<Cached<T>>): Promise<Part<T>> {
	try {
		return { ok: true, ...(await read()) };
	} catch (err) {
		const apiError = toApiError(err);
		if (!apiError) throw err;
		return { ok: false, error: apiError };
	}
}

/** Shown instead of asking, for a domain Porkbun is known to refuse every call on. */
const API_OFF: ApiError = {
	code: 'API_ACCESS_DISABLED',
	message: 'API access is off for this domain, so Porkbun does not answer for it.',
	url: 'https://porkbun.com/account/domainsSpeedy',
	retryable: false
};

/** Porkbun's public price list, all TLDs. Sent without the keys. */
function pricing(force: boolean) {
	return part(() => cached('_account:pricing', () => porkbun().pricing.get(), { force }));
}

/** Every domain in the account with its renewal price. Throws only when the list itself can not be read. */
export async function loadDomainList(opts: { force?: boolean } = {}): Promise<DomainList> {
	const force = opts.force ?? false;
	const [list, prices] = await Promise.all([listDomains({ force }), pricing(force)]);
	const table = prices.ok ? prices.data : {};
	return {
		data: list.data.map((d) => ({ ...d, renewal: table[d.tld]?.renewal || null })),
		fetchedAt: list.fetchedAt,
		stale: list.stale,
		pricingError: prices.ok ? null : prices.error
	};
}

/**
 * Everything the Overview tab shows for one domain (already through `requireDomain`). Each part is cached
 * and can fail on its own; with API access off only the reads that do not need it are made.
 */
export async function loadOverview(
	domain: DomainSummary,
	opts: { force?: boolean } = {}
): Promise<DomainOverview> {
	const force = opts.force ?? false;
	const d = domain.domain;
	const pb = porkbun();
	const gated = <T>(area: string, load: () => Promise<T>): Promise<Part<T>> =>
		domain.apiAccess
			? part(() => cached(`${d}:${area}:overview`, load, { force }))
			: Promise.resolve({ ok: false, error: API_OFF });

	const [detail, prices, nameservers, dns, history, forwards, glue, dnssec] = await Promise.all([
		part(() => cached(`${d}:domain`, () => pb.domains.get(d), { force })),
		pricing(force),
		// The one read shared with another tab: P3 caches the nameserver list under `<d>:ns` in this same
		// shape (`pb.ns.get`), so both tabs ask Porkbun once and can never disagree.
		domain.apiAccess
			? part(() => cached(`${d}:ns`, () => pb.ns.get(d), { force })).then((p): Part<NameserverSummary> =>
					p.ok ? { ...p, data: summariseNameservers(p.data) } : p
				)
			: Promise.resolve<Part<NameserverSummary>>({ ok: false, error: API_OFF }),
		gated('dns', async (): Promise<DnsCounts> => {
			const zone = await pb.dns.list(d);
			const byType: Record<string, number> = {};
			for (const r of zone.records) byType[r.type] = (byType[r.type] ?? 0) + 1;
			return { total: zone.records.length, byType, cloudflare: zone.cloudflare };
		}),
		gated('history', async (): Promise<HistoryCounts> => {
			const points = await pb.dns.history(d);
			const latest = points.reduce<string | null>(
				(max, p) => (max === null || p.takenAt > max ? p.takenAt : max),
				null
			);
			return { total: points.length, latest };
		}),
		gated('forwards', async () => (await pb.forwards.list(d)).length),
		gated('glue', async () => (await pb.glue.list(d)).length),
		gated('dnssec', async () => (await pb.dnssec.list(d)).length)
	]);
	return {
		detail,
		renewal: prices.ok ? prices.data[domain.tld]?.renewal || null : null,
		pricingError: prices.ok ? null : prices.error,
		nameservers,
		dns,
		history,
		forwards,
		glue,
		dnssec
	};
}

/** Prepaid credit and the API spend cap. A key without the permission gets a refusal for that half only. */
export async function loadAccount(opts: { force?: boolean } = {}): Promise<AccountInfo> {
	const force = opts.force ?? false;
	const pb = porkbun();
	const [balance, spend] = await Promise.all([
		part(() => cached('_account:balance', () => pb.account.balance(), { force })),
		part(() => cached('_account:spend', () => pb.account.apiSettings(), { force }))
	]);
	return { balance, spend };
}

// ── Auto-renew ──────────────────────────────────────────────────────────────────────────────────────────

/** Domains per `/domain/updateAutoRenew` request. Porkbun takes a list; this keeps each request modest. */
export const AUTO_RENEW_CHUNK = 100;
/** More than any account this UI is meant for; a guard against a runaway body, not a product limit. */
const MAX_BULK = 10_000;

const bad = (message: string): never => error(400, { message, code: 'BAD_REQUEST' });

/** `{ on: boolean }`, plus `domains: string[]` for the bulk route. Refuses anything else with a 400. */
export function parseAutoRenewBody(body: unknown, bulk: boolean): { on: boolean; domains: string[] } {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) bad('Send a JSON object.');
	const { on, domains } = body as { on?: unknown; domains?: unknown };
	if (typeof on !== 'boolean') bad('"on" must be true or false.');
	if (!bulk) return { on: on as boolean, domains: [] };
	if (!Array.isArray(domains) || domains.length === 0) bad('"domains" must be a list of domain names.');
	const list = domains as unknown[];
	if (list.length > MAX_BULK) bad(`At most ${MAX_BULK} domains at once.`);
	if (list.some((d) => typeof d !== 'string')) bad('"domains" must be a list of domain names.');
	const names = [...new Set((list as string[]).map((d) => d.trim().toLowerCase().replace(/\.$/, '')))];
	return { on: on as boolean, domains: names };
}

/** Every name through `requireDomain`, before anything is sent: one unknown name refuses the lot (404). */
export async function requireDomains(names: readonly string[]): Promise<DomainSummary[]> {
	const out: DomainSummary[] = [];
	for (const name of names) out.push(await requireDomain(name));
	return out;
}

/**
 * One `/domain/updateAutoRenew` request through `write()`. Every domain asked about gets a result, also when
 * Porkbun leaves one out or refuses the whole request. One domain is logged under its name; several are
 * logged as one account-wide action, because they were one request.
 */
export async function setAutoRenew(
	domains: readonly DomainSummary[],
	on: boolean,
	author: string
): Promise<WriteResult<{ results: AutoRenewResult[] }>> {
	const names = domains.map((d) => d.domain);
	const result = await write<{ results: AutoRenewResult[] }>({
		scope: 'domains',
		author,
		domain: names.length === 1 ? (names[0] as string) : '',
		action: 'autorenew.set',
		request: { domains: names, autoRenew: on },
		before: { autoRenew: Object.fromEntries(domains.map((d) => [d.domain, d.autoRenew])) },
		invalidate: [DOMAINS_KEY, ...names],
		run: (pb) => pb.domains.setAutoRenew(names, on)
	});
	if (!result.ok) return result;
	const said = new Map(result.data.results.map((r) => [r.domain, r]));
	const results = names.map(
		(domain) => said.get(domain) ?? { domain, ok: false, message: 'Porkbun did not report on this domain.' }
	);
	return { ...result, data: { results } };
}

/** The bulk version: requests of `AUTO_RENEW_CHUNK` in turn, with one result per domain at the end. */
export async function setAutoRenewBulk(
	domains: readonly DomainSummary[],
	on: boolean,
	author: string
): Promise<BulkAutoRenew> {
	const out: BulkAutoRenew = { results: [], warnings: [], auditIds: [] };
	for (let i = 0; i < domains.length; i += AUTO_RENEW_CHUNK) {
		const chunk = domains.slice(i, i + AUTO_RENEW_CHUNK);
		const res = await setAutoRenew(chunk, on, author);
		if (res.auditId !== undefined) out.auditIds.push(res.auditId);
		if (res.ok) {
			out.results.push(...res.data.results);
			out.warnings.push(...res.warnings);
		} else {
			const message = [res.error.code, res.error.message].filter(Boolean).join(': ');
			out.results.push(...chunk.map((d) => ({ domain: d.domain, ok: false, message })));
		}
	}
	return out;
}
