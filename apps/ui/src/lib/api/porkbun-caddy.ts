/**
 * Shapes of the Caddy tie-in (docs/porkbun-plan.md §4): `GET /api/porkbun/caddy`,
 * `POST /api/porkbun/caddy/records` and `POST /api/porkbun/caddy/challenges`, shared by the server and the
 * pages. Client-safe: no Node imports, and nothing here ever carries an API key.
 */
import type { ApiError, DryRun, PorkbunStatus, WriteResult } from './porkbun';

/** The Caddy module of github.com/caddy-dns/porkbun. */
export const PORKBUN_PLUGIN_MODULE = 'dns.providers.porkbun';

/**
 * Whether the running Caddy was built with the Porkbun DNS plugin.
 * - present: Caddy adapted a Caddyfile that uses `acme_dns porkbun`.
 * - missing: Caddy answered "module not registered".
 * - unknown: Caddy could not be asked, or answered something else; `reason` says what.
 */
export type PluginCheck = {
	module: typeof PORKBUN_PLUGIN_MODULE;
	state: 'present' | 'missing' | 'unknown';
	checkedAt: number;
	reason?: string;
};

/** How a site gets certificates through the DNS challenge, when it does. */
export type Dns01 = {
	/** Set in the site's own `tls` block, or for every site by the global `acme_dns` option. */
	source: 'site' | 'global';
	/** The provider name as written; null when the line names none and no global `dns` option fills it in. */
	provider: string | null;
};

/** A Porkbun record a site's name resolves through. */
export type RecordRef = {
	id: string;
	/** The domain whose zone holds the record. */
	domain: string;
	/** Fully qualified: `*.example.com`. */
	name: string;
	type: string;
	content: string;
};

/**
 * What the records at Porkbun say about one site address.
 * - ok: the name resolves to this server's public IP.
 * - missing: no record answers for the name.
 * - wrong: the name resolves to a public address that is not this server's.
 * - private: the name resolves to a private address (10.x, 192.168.x, …), which only works inside that network.
 * - external: a CNAME or ALIAS leads to a name outside this Porkbun account, so its target can not be checked.
 * - unverified: records exist but can not be compared (this server's public IP is unknown, or only the
 *   other address family has a record).
 * - elsewhere: the domain's nameservers are not Porkbun's, so the records at Porkbun are not what is served.
 * - unreadable: the zone could not be read; `error` on the domain says why.
 * - not_porkbun: the name is not under a domain in this Porkbun account.
 */
export type DnsCheckStatus =
	| 'ok'
	| 'missing'
	| 'wrong'
	| 'private'
	| 'external'
	| 'unverified'
	| 'elsewhere'
	| 'unreadable'
	| 'not_porkbun';

/** The one change that would make a site's name point at this server. */
export type RecordFix = {
	kind: 'create' | 'edit';
	domain: string;
	/** The part before the domain: `app`, `*`, or '' for the apex. */
	host: string;
	type: 'A' | 'AAAA';
	/** This server's public IP. */
	content: string;
	/** For an edit: the record that changes and what it holds now. */
	id?: string;
	before?: string;
};

export type DnsHintCode =
	| 'wildcard_needs_dns01'
	| 'dns01_not_in_account'
	| 'dns01_nameservers_elsewhere'
	| 'dns01_api_access_off'
	| 'dns01_plugin_missing';

export type DnsHint = {
	code: DnsHintCode;
	severity: 'info' | 'warning';
	message: string;
	/** `wildcard_needs_dns01` only: the Porkbun block can be added to the site in one step. */
	canAddPorkbun?: boolean;
};

/** One site address that is a host name. A site block with three addresses has three of these. */
export type SiteDnsCheck = {
	/** The host name, lower case: `app.example.com`, `*.example.com`. */
	host: string;
	/** The Porkbun records the name resolves through, in order (a CNAME, then what it points at). */
	records: RecordRef[];
	/** Whether the site gets its certificate through the DNS challenge. */
	dns01: boolean;
	dns01Detail: Dns01 | null;
	siteId: string;
	/** Every address of the site block, as written. */
	addresses: string[];
	/** 1-based line of the site block in the Caddyfile. */
	line: number;
	wildcard: boolean;
	/** The Porkbun domain the host is under, or null. */
	domain: string | null;
	status: DnsCheckStatus;
	/** One sentence saying what was found. */
	detail: string;
	/** Present when one record change makes the name point at this server. */
	fix: RecordFix | null;
	hints: DnsHint[];
};

/** A domain of the account that sites or challenge records were looked up in. */
export type DomainTieIn = {
	domain: string;
	apiAccess: boolean;
	/** null when they could not be read. */
	nameservers: string[] | null;
	/** Whether Porkbun's nameservers serve the zone; null when unknown. */
	servedByPorkbun: boolean | null;
	fetchedAt: number | null;
	stale: boolean;
	/** Why the zone or the nameservers could not be read. */
	error?: ApiError;
};

/** A `_acme-challenge` TXT record: Caddy creates one for a certificate order and removes it afterwards. */
export type ChallengeRecord = {
	id: string;
	domain: string;
	name: string;
	/** The name the certificate is for: `_acme-challenge.app.example.com` is for `app.example.com` and `*.app.example.com`. */
	subject: string;
	content: string;
	/** When this UI first saw the record, in ms since the epoch. Porkbun does not say when it was made. */
	firstSeen: number;
	/** Seen for more than a day: Caddy's orders take minutes, so it was left behind. */
	stale: boolean;
	/** Sites whose certificate the record belongs to. */
	sites: string[];
};

/** `GET /api/porkbun/caddy`. With `?only=plugin` only `plugin` is filled and Porkbun is not asked. */
export type CaddyTieIn = {
	plugin: PluginCheck;
	porkbun: PorkbunStatus['state'];
	/** This server's public IP as Porkbun saw it, or null. */
	publicIp: string | null;
	/** The global `acme_dns` option, when set. */
	globalDns01: { provider: string | null } | null;
	/** Why the Caddyfile could not be read, when it could not. */
	caddyfileError: string | null;
	sites: SiteDnsCheck[];
	domains: DomainTieIn[];
	challenges: ChallengeRecord[];
	/** Oldest read used for this answer, in ms since the epoch. */
	asOf: number;
	/** Some of it is the last good data because Porkbun could not be asked. */
	stale: boolean;
	/** Why nothing could be looked up at Porkbun, when that is so (keys refused, unreachable). */
	error?: ApiError;
};

/** Body of `POST /api/porkbun/caddy/records`. */
export type RecordFixRequest = {
	/** The site address to fix: `app.example.com`. */
	host: string;
	/** Rehearse it: Porkbun validates the change and nothing is changed. */
	dryRun?: boolean;
	/** The fix the person reviewed. When the records changed since, the answer is a 409 with the new one. */
	expect?: RecordFix;
};

export type RecordFixPreview = { fix: RecordFix; dryRun: DryRun };
export type RecordFixResult = { fix: RecordFix; result: WriteResult<{ id?: string }> };

/** Body of `POST /api/porkbun/caddy/challenges`: delete left-behind challenge records by id. */
export type ChallengeCleanupRequest = {
	domain: string;
	ids: string[];
	/** Rehearse it: Porkbun validates each delete and nothing is deleted. */
	dryRun?: boolean;
};
/** The rehearsal of a cleanup, all deletes taken together: it would succeed only when every one would. */
export type ChallengeCleanupPreview = { dryRun: DryRun };
export type ChallengeCleanupResult = {
	results: { id: string; name: string; result: WriteResult }[];
};

export const DNS_STATUS_LABEL: Record<DnsCheckStatus, string> = {
	ok: 'Points here',
	missing: 'No record',
	wrong: 'Points elsewhere',
	private: 'Private address',
	external: 'External target',
	unverified: 'Not checked',
	elsewhere: 'DNS elsewhere',
	unreadable: 'Unreadable',
	not_porkbun: 'Not at Porkbun'
};

/** Tag colour for a status: only "missing" and "wrong" are problems this UI can fix. */
export function dnsStatusKind(status: DnsCheckStatus): 'success' | 'warning' | 'error' | 'neutral' {
	if (status === 'ok') return 'success';
	if (status === 'missing' || status === 'wrong') return 'error';
	if (status === 'elsewhere' || status === 'unreadable') return 'warning';
	return 'neutral';
}

/** The record a fix leaves behind, as one line: `A app.example.com → 203.0.113.10`. */
export function fixTitle(fix: RecordFix): string {
	return `${fix.type} ${fix.host === '' ? fix.domain : `${fix.host}.${fix.domain}`}`;
}
