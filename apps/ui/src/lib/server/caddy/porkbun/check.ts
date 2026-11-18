import type { ApiError, Cached, DnsRecord, DnsZone, DomainSummary } from '$lib/api/porkbun';
import type {
	CaddyTieIn,
	ChallengeRecord,
	DnsHint,
	DomainTieIn,
	PluginCheck,
	RecordFix,
	RecordRef,
	SiteDnsCheck
} from '$lib/api/porkbun-caddy';
import { getConfigService } from '../../config';
import { getDb } from '../../db';
import { cached, listDomains, porkbun, porkbunStatus, toApiError } from '../../porkbun';
import { readCaddyfile, type CaddyfileFacts, type SiteFacts, type SiteHost } from './caddyfile';
import { observeChallenges } from './challenges';
import { getPluginDetector } from './plugin';
import {
	domainOf,
	hostLabel,
	ipFamily,
	isPrivateIp,
	resolveName,
	sameIp,
	type Resolution,
	type ZoneRecord
} from './resolve';

/**
 * The site-to-DNS cross-check (docs/porkbun-plan.md §4): for every site address under a Porkbun domain,
 * which record answers for it and whether that points at this server's public IP; which sites use the DNS
 * challenge and whether that can work; and the challenge records Caddy left at Porkbun.
 *
 * Reads only. Zones are read through the shared cache under the same key the DNS tab uses
 * (`<domain>:dns`), so opening both costs one request, and a write anywhere drops it.
 */
export type TieInOptions = {
	/** Only this domain (already through `requireDomain`). Its zone is read even when no site uses it. */
	domain?: string;
	/** Only this site address. */
	host?: string;
	/** Ask Porkbun and Caddy again instead of using what was cached. */
	force?: boolean;
	/** Read the records and nameservers again, but keep the cached domain list and plugin check. */
	freshZones?: boolean;
	now?: number;
};

const PORKBUN_PROVIDER = 'porkbun';

/** Porkbun's own nameservers all sit under this name (`maceio.ns.porkbun.com`, …). */
const servedByPorkbun = (ns: readonly string[]): boolean =>
	ns.length > 0 && ns.every((n) => n === 'porkbun.com' || n.endsWith('.porkbun.com'));

const ref = (r: ZoneRecord): RecordRef => ({
	id: r.id,
	domain: r.domain,
	name: r.name,
	type: r.type,
	content: r.content
});

const list = (values: readonly string[]): string =>
	values.length <= 1 ? (values[0] ?? '') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;

type Verdict = Pick<SiteDnsCheck, 'status' | 'detail' | 'fix'>;

/** What the records say about one name, given this server's public IP. Pure. */
export function judge(host: string, domain: string, res: Resolution, publicIp: string | null): Verdict {
	const family = publicIp ? ipFamily(publicIp) : null;
	const label = hostLabel(host, domain);
	const create = (): RecordFix | null =>
		publicIp && family ? { kind: 'create', domain, host: label, type: family, content: publicIp } : null;
	const through = res.viaAlias ? ` through ${res.chain[0]?.type} ${res.chain[0]?.content}` : '';

	if (res.unreadable) {
		return {
			status: 'unreadable',
			detail: `It leads to ${res.unreadable}, whose records could not be read.`,
			fix: null
		};
	}
	if (res.addresses.length === 0) {
		if (res.external) {
			return {
				status: 'external',
				detail: `A ${res.chain.at(-1)?.type ?? 'CNAME'} record points it at ${res.external}, which is outside this Porkbun account, so where that leads can not be checked from here.`,
				fix: null
			};
		}
		if (res.viaAlias) {
			return {
				status: 'missing',
				detail: `A ${res.chain[0]?.type} record points it at ${res.chain.at(-1)?.content}, which has no address record.`,
				fix: null
			};
		}
		return { status: 'missing', detail: 'No record answers for this name.', fix: create() };
	}

	const where = res.viaWildcard ? ` (through the wildcard record ${res.addresses[0]?.name})` : through;
	if (!publicIp || !family) {
		return {
			status: 'unverified',
			detail: `It points at ${list(res.addresses.map((a) => a.content))}${where}. This server's public IP is not known, so that could not be compared.`,
			fix: null
		};
	}
	const same = res.addresses.filter((a) => a.type === family);
	if (same.length === 0) {
		const other = family === 'A' ? 'AAAA' : 'A';
		return {
			status: 'unverified',
			detail: `It has only ${other} records (${list(res.addresses.map((a) => a.content))})${where}. This server is known by its ${family === 'A' ? 'IPv4' : 'IPv6'} address ${publicIp}, so they can not be compared.`,
			fix: null
		};
	}
	const off = same.filter((a) => !sameIp(a.content, publicIp));
	if (off.length === 0) {
		return { status: 'ok', detail: `It points at this server (${publicIp})${where}.`, fix: null };
	}
	if (off.length < same.length) {
		return {
			status: 'wrong',
			detail: `It points at this server (${publicIp}) and also at ${list(off.map((a) => a.content))}${where}, so only some visitors arrive here. Remove the extra record on the DNS tab.`,
			fix: null
		};
	}
	const targets = list(off.map((a) => a.content));
	if (off.every((a) => isPrivateIp(a.content))) {
		return {
			status: 'private',
			detail: `It points at the private address ${targets}${where}. That works only from inside that network, which is fine when the site is meant to be internal.`,
			fix: null
		};
	}
	// One record of the name itself can be changed in place. Behind a wildcard, the name gets a record of its
	// own, so the other names under the wildcard keep going where they go. Behind a CNAME there is no one
	// record to change.
	let fix: RecordFix | null = null;
	const only = same[0];
	if (res.viaWildcard) fix = create();
	else if (!res.viaAlias && same.length === 1 && only) {
		fix = {
			kind: 'edit',
			domain,
			host: label,
			type: family,
			content: publicIp,
			id: only.id,
			before: only.content
		};
	}
	return {
		status: 'wrong',
		detail: `It points at ${targets}${where}, not at this server (${publicIp}).`,
		fix
	};
}

function hintsFor(
	site: SiteFacts,
	host: SiteHost,
	domain: DomainSummary | undefined,
	info: DomainTieIn | undefined,
	plugin: PluginCheck
): DnsHint[] {
	const hints: DnsHint[] = [];
	const usesPorkbun = site.dns01?.provider === PORKBUN_PROVIDER;
	if (host.wildcard && host.https && site.certificate === 'acme' && !site.onDemand && !site.dns01) {
		const can = domain !== undefined && plugin.state !== 'missing';
		hints.push({
			code: 'wildcard_needs_dns01',
			severity: 'warning',
			message:
				'A wildcard certificate can only be issued through the DNS challenge, and this site does not use it, so Caddy can not get a certificate for it.' +
				(domain === undefined
					? ' Its domain is not in this Porkbun account, so the challenge has to be set up with the provider that serves it.'
					: plugin.state === 'missing'
						? ' The running Caddy has no Porkbun plugin; build it in first.'
						: ''),
			canAddPorkbun: can
		});
	}
	if (!usesPorkbun) return hints;
	if (plugin.state === 'missing') {
		hints.push({
			code: 'dns01_plugin_missing',
			severity: 'warning',
			message:
				'This site uses the Porkbun DNS challenge, but the running Caddy does not have the Porkbun plugin and will refuse the Caddyfile.'
		});
	}
	if (domain === undefined) {
		hints.push({
			code: 'dns01_not_in_account',
			severity: 'warning',
			message: `This site uses the Porkbun DNS challenge, but ${host.host} is not under a domain in this Porkbun account. If Caddy uses the same key, it can not create the challenge record.`
		});
		return hints;
	}
	if (!domain.apiAccess) {
		hints.push({
			code: 'dns01_api_access_off',
			severity: 'warning',
			message: `This site uses the Porkbun DNS challenge, but API access is off for ${domain.domain} at Porkbun, so Caddy can not create the challenge record.`
		});
	}
	if (info?.servedByPorkbun === false) {
		hints.push({
			code: 'dns01_nameservers_elsewhere',
			severity: 'warning',
			message: `This site uses the Porkbun DNS challenge, but ${domain.domain} is served by other nameservers (${list(info.nameservers ?? [])}). The certificate authority will not see the record Caddy creates at Porkbun.`
		});
	}
	return hints;
}

type ZoneRead = { info: DomainTieIn; records: DnsRecord[] | null };

async function readZone(d: DomainSummary, force: boolean): Promise<ZoneRead> {
	const info: DomainTieIn = {
		domain: d.domain,
		apiAccess: d.apiAccess,
		nameservers: null,
		servedByPorkbun: null,
		fetchedAt: null,
		stale: false
	};
	if (!d.apiAccess) {
		info.error = {
			code: 'API_ACCESS_DISABLED',
			message: `API access is off for ${d.domain} at Porkbun, so its records can not be read.`,
			retryable: false
		};
		return { info, records: null };
	}
	const pb = porkbun();
	const fail = (err: unknown): null => {
		const apiError: ApiError | null = toApiError(err);
		if (!apiError) throw err;
		info.error ??= apiError;
		return null;
	};
	const [zone, ns] = await Promise.all([
		cached<DnsZone>(`${d.domain}:dns`, () => pb.dns.list(d.domain), { force }).catch(fail),
		// Below `<domain>:ns`, so a nameserver change drops it, whatever the Registry tab keeps at that key.
		cached<string[]>(`${d.domain}:ns:caddy`, () => pb.ns.get(d.domain), { force }).catch(fail)
	]);
	const reads = [zone, ns].filter((c): c is Cached<DnsZone> | Cached<string[]> => c !== null);
	if (reads.length > 0) {
		info.fetchedAt = Math.min(...reads.map((c) => c.fetchedAt));
		info.stale = reads.some((c) => c.stale);
	}
	if (ns) {
		info.nameservers = ns.data;
		info.servedByPorkbun = servedByPorkbun(ns.data);
	}
	// Another reader of the key may keep another shape; only trust what looks like a zone.
	const records = zone && Array.isArray(zone.data?.records) ? zone.data.records : null;
	return { info, records };
}

async function readFacts(): Promise<{ facts: CaddyfileFacts; error: string | null }> {
	const empty: CaddyfileFacts = { sites: [], globalDns01: null };
	try {
		const file = await getConfigService().readFile();
		if (!file.exists) return { facts: empty, error: 'The Caddyfile does not exist yet.' };
		return { facts: readCaddyfile(file.text), error: null };
	} catch (err) {
		return { facts: empty, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Only the plugin check: asks Caddy, never Porkbun. */
export async function pluginOnly(force = false): Promise<Pick<CaddyTieIn, 'plugin'>> {
	return { plugin: await getPluginDetector().check({ force }) };
}

export async function caddyTieIn(opts: TieInOptions = {}): Promise<CaddyTieIn> {
	const now = opts.now ?? Date.now();
	const force = opts.force === true;
	const [plugin, { facts, error: caddyfileError }, status] = await Promise.all([
		getPluginDetector().check({ force }),
		readFacts(),
		porkbunStatus()
	]);
	const out: CaddyTieIn = {
		plugin,
		porkbun: status.state,
		publicIp: status.publicIp ?? null,
		globalDns01: facts.globalDns01,
		caddyfileError,
		sites: [],
		domains: [],
		challenges: [],
		asOf: now,
		stale: false
	};
	if (status.state === 'off' || status.state === 'misconfigured') return out;

	let account: Cached<DomainSummary[]>;
	try {
		account = await listDomains(force ? { force } : undefined);
	} catch (err) {
		const apiError = toApiError(err);
		if (!apiError) throw err;
		return { ...out, error: apiError };
	}
	const byName = new Map(account.data.map((d) => [d.domain, d]));
	const names = [...byName.keys()];

	type Row = { site: SiteFacts; host: SiteHost; domain: string | null };
	const rows: Row[] = [];
	for (const site of facts.sites) {
		for (const host of site.hosts) {
			if (opts.host !== undefined && host.host !== opts.host) continue;
			const domain = domainOf(host.host, names);
			if (opts.domain !== undefined && domain !== opts.domain) continue;
			rows.push({ site, host, domain });
		}
	}

	// One read per domain, shared by every name that needs it (CNAME targets in other zones included).
	const zones = new Map<string, Promise<ZoneRead>>();
	const zone = (domain: string): Promise<ZoneRead> => {
		let read = zones.get(domain);
		if (!read) {
			read = readZone(byName.get(domain) as DomainSummary, force || opts.freshZones === true);
			zones.set(domain, read);
		}
		return read;
	};
	const recordsOf = async (domain: string) => (await zone(domain)).records;
	if (opts.domain !== undefined && byName.has(opts.domain)) void zone(opts.domain);
	for (const row of rows) if (row.domain) void zone(row.domain);

	out.sites = await Promise.all(
		rows.map(async ({ site, host, domain }): Promise<SiteDnsCheck> => {
			const base = {
				host: host.host,
				dns01: site.dns01 !== null,
				dns01Detail: site.dns01,
				siteId: site.id,
				addresses: site.addresses,
				line: site.line,
				wildcard: host.wildcard,
				domain
			};
			if (domain === null) {
				return {
					...base,
					records: [],
					status: 'not_porkbun',
					detail: 'This name is not under a domain in this Porkbun account.',
					fix: null,
					hints: hintsFor(site, host, undefined, undefined, plugin)
				};
			}
			const read = await zone(domain);
			const hints = hintsFor(site, host, byName.get(domain), read.info, plugin);
			if (read.records === null) {
				return {
					...base,
					records: [],
					status: 'unreadable',
					detail: read.info.error?.message ?? `The records of ${domain} could not be read.`,
					fix: null,
					hints
				};
			}
			const res = await resolveName(host.host, names, recordsOf);
			const records = res.chain.map(ref);
			if (read.info.servedByPorkbun === false) {
				return {
					...base,
					records,
					status: 'elsewhere',
					detail: `${domain} is served by other nameservers (${list(read.info.nameservers ?? [])}), so the records at Porkbun are not what visitors get.`,
					fix: null,
					hints
				};
			}
			return { ...base, records, ...judge(host.host, domain, res, out.publicIp), hints };
		})
	);

	const reads = await Promise.all([...zones.values()]);
	out.domains = reads.map((r) => r.info).sort((a, b) => a.domain.localeCompare(b.domain));
	const allHosts = facts.sites.flatMap((s) => s.hosts.map((h) => h.host));
	const challenges: ChallengeRecord[] = [];
	for (const r of reads) {
		if (r.records === null || r.info.stale) continue;
		if (opts.domain !== undefined && r.info.domain !== opts.domain) continue;
		challenges.push(...observeChallenges(getDb(), r.info.domain, r.records, allHosts, now));
	}
	out.challenges = challenges;
	const times = [
		account.fetchedAt,
		...out.domains.flatMap((d) => (d.fetchedAt === null ? [] : [d.fetchedAt]))
	];
	out.asOf = Math.min(...times);
	out.stale = account.stale || out.domains.some((d) => d.stale);
	return out;
}
