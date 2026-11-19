/**
 * Shapes shared by the Porkbun server module (`$lib/server/porkbun`), the `/api/porkbun/*` routes and the
 * Domains pages (docs/porkbun-plan.md §3.2). Client-safe: no Node imports, and nothing here ever carries an
 * API key.
 *
 * Porkbun sends numbers as strings, flags as 0/1 or "yes"/"no" and dates as "YYYY-MM-DD HH:MM:SS" in UTC.
 * The client converts all of that, so everything below is in plain JSON types and ISO 8601 dates.
 */

/** A key's permissions, as `/ping` reports them. A full-access key has all eight. */
export type PorkbunScope =
	'read' | 'dns' | 'domains' | 'email' | 'hosting' | 'purchase' | 'funding' | 'account';

export const PORKBUN_SCOPES: readonly PorkbunScope[] = [
	'read',
	'dns',
	'domains',
	'email',
	'hosting',
	'purchase',
	'funding',
	'account'
];

/**
 * What the Domains area can do right now.
 * - off: neither key is set. The area explains the set-up and makes no calls.
 * - misconfigured: exactly one key is set; `missing` names the other variable.
 * - ok: `/ping` accepted the keys; `scopes`, `publicIp` and `account` are filled.
 * - error: both keys are set but Porkbun refused them or could not be reached; `error` says why.
 */
export type PorkbunStatus = {
	state: 'off' | 'misconfigured' | 'ok' | 'error';
	missing?: 'PORKBUN_API_KEY' | 'PORKBUN_API_SECRET_KEY';
	/** The key is a Porkbun sandbox key (`pk1_sb_…`): nothing real is touched. */
	sandbox: boolean;
	/** `CADDY_UI_PORKBUN_READONLY`: every write is refused by this UI. */
	readonly: boolean;
	scopes: PorkbunScope[];
	/** The address Porkbun saw this server call from. */
	publicIp?: string;
	/** Username of the Porkbun account the key belongs to. */
	account?: string;
	/** When `/ping` last answered, in ms since the epoch. */
	checkedAt?: number;
	error?: ApiError;
};

export type DomainLabel = { id: string; title: string; color: string };

export type DomainSummary = {
	domain: string;
	tld: string;
	/** Porkbun's registration status, for example ACTIVE. */
	status: string;
	/** ISO 8601 UTC, or '' when Porkbun sent no usable date. */
	createDate: string;
	/** ISO 8601 UTC, or '' when Porkbun sent no usable date. */
	expireDate: string;
	autoRenew: boolean;
	securityLock: boolean;
	whoisPrivacy: boolean;
	/** Whether the domain is opted in to API access at Porkbun. Without it every other call is refused. */
	apiAccess: boolean;
	/** Managed outside Porkbun (not authoritative). */
	notLocal: boolean;
	labels: DomainLabel[];
};

export const DNS_RECORD_TYPES = [
	'A',
	'AAAA',
	'MX',
	'CNAME',
	'ALIAS',
	'TXT',
	'NS',
	'SRV',
	'TLSA',
	'CAA',
	'SSHFP',
	'HTTPS',
	'SVCB',
	'DS'
] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/**
 * The type of a record read from Porkbun: one of the 14 this build edits, or a newer one. Records of a type
 * `isKnownRecordType` rejects are shown read-only, never dropped (docs/porkbun-plan.md §7).
 */
export type AnyRecordType = DnsRecordType | (string & {});

export function isKnownRecordType(type: string): type is DnsRecordType {
	return (DNS_RECORD_TYPES as readonly string[]).includes(type);
}

export type DnsRecord = {
	id: string;
	/** Fully qualified, lower case: `www.example.com`. */
	name: string;
	/** The part before the domain: `www`, `*`, or '' for the apex. */
	host: string;
	type: AnyRecordType;
	content: string;
	ttl: number;
	/** Priority, for MX and SRV. null where Porkbun sent none. */
	prio: number | null;
	notes: string | null;
};

export type DnsRecordInput = {
	/** '' for the apex. Never includes the domain. */
	host: string;
	type: DnsRecordType;
	content: string;
	/** Seconds. Porkbun raises it to the account minimum (usually 600). */
	ttl?: number;
	prio?: number;
	/** Not served in DNS. On an edit, '' clears the notes and leaving it out keeps them. */
	notes?: string;
};

/** `GET …/dns`: the editable records (no SOA, no default NS). */
export type DnsZone = {
	records: DnsRecord[];
	/** Porkbun's own Cloudflare proxy toggle for the domain. */
	cloudflare: boolean;
	/** What Porkbun had to say along with the records, as written. Absent when it said nothing. */
	warnings?: string[];
};

/** A cached read. `stale` means Porkbun could not be asked and this is the last good answer. */
export type Cached<T> = { data: T; fetchedAt: number; stale: boolean };

/**
 * An error to show. `code` is Porkbun's (for example DUPLICATE_RECORD) or one of this UI's: UNREACHABLE,
 * NOT_CONFIGURED, READ_ONLY, DOMAIN_NOT_IN_ACCOUNT, BAD_REQUEST. Branch on `code` and `retryable`, never on
 * `message`.
 */
export type ApiError = {
	code: string;
	message: string;
	/** What to do about it, from Porkbun's `next_action.hint`. */
	hint?: string;
	/** Where to do it, from `next_action.url`. Always https. */
	url?: string;
	retryable: boolean;
	requestId?: string;
	/** Seconds to wait, on a rate limit. */
	retryAfter?: number;
	/**
	 * The other fields Porkbun sent with the error, for example `existingId` (DUPLICATE_RECORD),
	 * `conflictingRecords` (RECORD_CONFLICT), `count` and `limit` (ZONE_RECORD_LIMIT), `requiredScope` and
	 * `keyScopes` (INSUFFICIENT_SCOPE).
	 */
	details?: Record<string, unknown>;
};

export type WriteResult<T = unknown> =
	| { ok: true; data: T; warnings: string[]; auditId: number }
	| { ok: false; error: ApiError; auditId?: number };

/** A rehearsed write: Porkbun validated it and changed nothing. */
export type DryRun = { wouldSucceed: boolean; warnings: string[]; error?: ApiError };

/** Body of every non-2xx answer from `/api/porkbun/*`. */
export type PorkbunFailure = { message: string; code: string; error: ApiError };

/** One row of `GET /api/porkbun/audit`. `request`, `before` and `result` are whatever the write recorded. */
export type AuditEntry = {
	id: number;
	ts: number;
	author: string;
	/** The domain, or '' for an account-wide action. */
	domain: string;
	/** Dotted, area first: `dns.create`, `ns.update`, `autorenew.set`. */
	action: string;
	request: unknown;
	before: unknown;
	ok: boolean;
	result: unknown;
	requestId: string | null;
};

export type AuditList = { entries: AuditEntry[]; nextBefore: number | null };

// ── Results of the client's reads and writes, by area ────────────────────────────────────────────────────

/** What every write returns besides its own data. `warnings` are Porkbun's, to be shown as written. */
export type Written<T = object> = T & { warnings: string[]; requestId?: string };

export type AutoRenewResult = { domain: string; ok: boolean; message: string };

export type PreflightIntent = 'general' | 'move-nameservers' | 'transfer-out' | 'enable-dnssec';

export type PreflightCheck = {
	id: string;
	severity: 'blocker' | 'warning' | 'info';
	ok: boolean;
	title: string;
	detail: string;
	/** Absent on checks that passed. */
	nextAction?: string;
};

export type Preflight = {
	intent: string;
	/** True only with no blockers and no warnings. */
	safe: boolean;
	/** Check ids that will break something. */
	blockers: string[];
	warnings: string[];
	checks: PreflightCheck[];
};

export type RestorePoint = {
	id: number;
	/** ISO 8601 UTC. */
	takenAt: string;
	reason: string;
	source: string;
	/** Size of the zone when the point was taken. */
	recordCount: number;
	matchesLive: boolean;
};

/** A record in a restore point or a diff: identified by its data, not by an id. */
export type SnapshotRecord = {
	name: string;
	type: string;
	content: string;
	ttl: number;
	prio: number | null;
};

export type ZoneDiff = {
	snapshot: { id: number; takenAt: string; reason: string };
	/** In the restore point, not live. A restore adds these back. */
	missing: SnapshotRecord[];
	/** Live, not in the restore point. A restore leaves these alone unless `prune`. */
	extra: SnapshotRecord[];
	inSync: boolean;
};

export type RestoreResult = {
	/** True when this was a rehearsal and nothing changed. */
	dryRun: boolean;
	restoredFrom: number;
	/** The restore point holding the state from just before; restore it to undo. null on a dry run. */
	previousStateSavedAs: number | null;
	restored: number;
	removed: number;
	failed: { name: string; type: string; reason: string }[];
};

/** A record for `/dns/import` or from `/dns/scan`. `host` is the part before the domain, '' for the apex. */
export type ImportRecord = { host: string; type: string; content: string; ttl?: number; prio?: number };

export type ImportResult = {
	dryRun: boolean;
	created: number;
	/** Already present. */
	skipped: number;
	failed: number;
	failures: unknown[];
};

export type DnssecRecord = {
	keyTag: string;
	alg: string;
	digestType: string;
	digest: string;
	/** Present for key data records. */
	pubKey?: string;
};

export type DnssecInput = {
	keyTag: string;
	alg: string;
	digestType: string;
	digest: string;
	maxSigLife?: string;
	keyDataFlags?: string;
	keyDataProtocol?: string;
	keyDataAlgo?: string;
	keyDataPubKey?: string;
};

export type GlueHost = { host: string; v4: string[]; v6: string[] };

export type RedirectType = '301' | '302' | '307' | 'masked';

export type UrlForward = {
	id: string;
	/** '' for the apex. */
	subdomain: string;
	location: string;
	redirectType: RedirectType;
	includePath: boolean;
	wildcard: boolean;
};

export type UrlForwardInput = Omit<UrlForward, 'id'>;

/** The Porkbun-issued certificate. `privateKey` must never be cached, logged or audited. */
export type SslBundle = { certificateChain: string; privateKey: string; publicKey: string };

/** US dollars, as Porkbun prints them ("9.73"). */
export type TldPrice = { registration: string; renewal: string; transfer: string; specialType?: string };

export type Pricing = Record<string, TldPrice>;

export type AccountBalance = { cents: number; display: string };

export type SpendSettings = {
	/** Cents, or null when the account holder set none. */
	monthlySpendLimit: number | null;
	lowBalanceAlert: number | null;
	autoTopup: boolean;
	monthlySpend: number;
	/** The cap on API purchases actually enforced. */
	spendLimit: { limit: number | null; source: string; spent: number; remaining: number | null } | null;
};

/** Porkbun's default nameservers, for "back to Porkbun defaults". */
export const PORKBUN_NAMESERVERS: readonly string[] = [
	'maceio.ns.porkbun.com',
	'curitiba.ns.porkbun.com',
	'salvador.ns.porkbun.com',
	'fortaleza.ns.porkbun.com'
];

/**
 * Why a write is not offered, or null when it is. One rule for the server (`requireWritable`) and for the
 * controls (`ScopeGate`), so a control is never enabled for something the server would refuse.
 */
export function writeBlock(
	status: Pick<PorkbunStatus, 'state' | 'readonly' | 'scopes'>,
	scope: PorkbunScope
): { code: 'READ_ONLY' | 'INSUFFICIENT_SCOPE' | 'NOT_CONFIGURED'; message: string } | null {
	if (status.state === 'off' || status.state === 'misconfigured') {
		return { code: 'NOT_CONFIGURED', message: 'Porkbun is not set up' };
	}
	if (status.readonly) {
		return {
			code: 'READ_ONLY',
			message: 'Read-only mode is on (CADDY_UI_PORKBUN_READONLY), so nothing can be changed from here'
		};
	}
	// Scopes are only known after a successful /ping; until then Porkbun itself is the judge.
	if (status.state === 'ok' && !status.scopes.includes(scope)) {
		return {
			code: 'INSUFFICIENT_SCOPE',
			message: `The API key does not have the "${scope}" permission. Change the key's permissions at porkbun.com/account/api`
		};
	}
	return null;
}
