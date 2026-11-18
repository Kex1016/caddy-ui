import { isHttpError } from '@sveltejs/kit';
import type { ApiError, Cached, DnsZone } from '$lib/api/porkbun';
import {
	markRecords,
	marksFromCaddy,
	sitesInDomain,
	type MarkMap,
	type SiteUse
} from '$lib/porkbun/records/marks';
import { readZone } from '$lib/porkbun/records/service.server';
import { getConfigService } from '$lib/server/config';
import { cached, isConfigured, porkbun, requireDomain, toApiError } from '$lib/server/porkbun';
import { scanBlocks } from '$lib/server/sites/blocks';
import type { PageServerLoad } from './$types';

export type DnsPageData = {
	zone: Cached<DnsZone> | null;
	zoneError: ApiError | null;
	/** The nameservers at the registry, or null when they could not be read. */
	nameservers: string[] | null;
	/** Sites of the Caddyfile under this domain. */
	sites: SiteUse[];
	/** Record id to what depends on it. */
	marks: MarkMap;
};

const EMPTY: DnsPageData = { zone: null, zoneError: null, nameservers: null, sites: [], marks: {} };

/** The tie-in must never hold this page up: past this, the marks are worked out here. */
const TIE_IN_WAIT_MS = 1500;

/** Sites whose address is a name under the domain. A Caddyfile that can not be read marks nothing. */
async function sitesOf(domain: string): Promise<SiteUse[]> {
	try {
		const file = await getConfigService().readFile();
		const blocks = scanBlocks(file.text).blocks.filter((b) => b.kind === 'site');
		return sitesInDomain(blocks, domain);
	} catch {
		return [];
	}
}

/** The Caddy tie-in's cross-check (workstream P5), when that route exists and answers in time. */
async function tieIn(fetcher: typeof fetch): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const late = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), TIE_IN_WAIT_MS);
		});
		const answer = fetcher('/api/porkbun/caddy').then(async (res) => (res.ok ? await res.json() : null));
		return await Promise.race([answer, late]);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** The DNS tab: the zone, what Caddy depends on in it, and where the domain is delegated. */
export const load: PageServerLoad = async ({ params, fetch }): Promise<DnsPageData> => {
	// The layouts redirect when the keys are unset and show the error when the domain is not in the account.
	if (!isConfigured()) return EMPTY;
	let domain: string;
	try {
		domain = (await requireDomain(params.domain)).domain;
	} catch (err) {
		if (isHttpError(err) || toApiError(err)) return EMPTY;
		throw err;
	}

	const pb = porkbun();
	const [zoneRead, nameservers, sites, crossCheck] = await Promise.all([
		readZone(domain).then(
			(zone) => ({ zone, zoneError: null }),
			(err: unknown) => {
				const zoneError = toApiError(err);
				if (!zoneError) throw err;
				return { zone: null, zoneError };
			}
		),
		// The same cache entry the Registry tab reads. A failure here only costs the notice about delegation.
		cached(`${domain}:ns`, () => pb.ns.get(domain)).then(
			(ns) => ns.data,
			() => null
		),
		sitesOf(domain),
		tieIn(fetch)
	]);

	const records = zoneRead.zone?.data.records ?? [];
	const marks = marksFromCaddy(crossCheck, records, sites, domain) ?? markRecords(records, sites, domain);
	return { ...zoneRead, nameservers, sites, marks };
};
