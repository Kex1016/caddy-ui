import { randomUUID } from 'node:crypto';
import {
	PORKBUN_SCOPES,
	type AccountBalance,
	type AutoRenewResult,
	type DnsRecord,
	type DnsRecordInput,
	type DnsRecordType,
	type DnssecInput,
	type DnssecRecord,
	type DnsZone,
	type DomainSummary,
	type DryRun,
	type GlueHost,
	type ImportRecord,
	type ImportResult,
	type Preflight,
	type PreflightCheck,
	type PreflightIntent,
	type Pricing,
	type PorkbunScope,
	type RedirectType,
	type RestorePoint,
	type RestoreResult,
	type SnapshotRecord,
	type SpendSettings,
	type SslBundle,
	type UrlForward,
	type UrlForwardInput,
	type Written,
	type ZoneDiff
} from '$lib/api/porkbun';
import {
	PorkbunError,
	PorkbunUnreachable,
	redactDeep,
	redactor,
	toApiError,
	type NextAction
} from './errors';

/**
 * The only file that performs HTTP to Porkbun (docs/porkbun-plan.md §3). One method per endpoint in §2.
 *
 * - Reads are GET, writes are POST. The keys go in the `X-API-Key` / `X-Secret-API-Key` headers and never in
 *   a body, so bodies can be logged.
 * - Every POST carries an `Idempotency-Key`. Writes are never retried here; a caller that wants to retry one
 *   passes the same key again (`WriteOpts.idempotencyKey`).
 * - A read that is rate limited is retried once after `Retry-After`, if that is at most `maxRetryAfterMs`.
 * - Every path segment is URL-encoded, and '.', '..' and empty segments are refused before any request.
 * - Failures are `PorkbunError` (Porkbun said no) or `PorkbunUnreachable` (no usable answer). Neither ever
 *   contains a key: everything taken from a response is passed through a redactor first.
 * - Porkbun's strings-for-numbers, 0/1 flags and "YYYY-MM-DD HH:MM:SS" dates are converted here.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PorkbunOptions = {
	apiKey: string;
	apiSecret: string;
	/** Without a trailing slash, for example `https://api.porkbun.com/api/json/v3`. */
	baseUrl: string;
	fetch?: FetchLike;
	/** Per request. Default 15 s. */
	timeoutMs?: number;
	/** Longest `Retry-After` a rate-limited read waits out before giving up. Default 5 s. */
	maxRetryAfterMs?: number;
	/** Requests in flight at once; the rest queue. Default 4. */
	concurrency?: number;
	sleep?: (ms: number) => Promise<void>;
	newIdempotencyKey?: () => string;
};

export type WriteOpts = {
	/** Reuse the key of an earlier attempt to make a retry safe. Default: a fresh UUID. */
	idempotencyKey?: string;
};

export type PingResult = {
	ip: string;
	credentialsValid: boolean;
	account?: string;
	scopes: PorkbunScope[];
};

type Json = Record<string, unknown>;
type Query = Record<string, string | number | undefined>;
type Reply = { body: Json; requestId: string | undefined };

export const SANDBOX_KEY_PREFIX = 'pk1_sb_';

// ── Conversions ──────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

function flag(v: unknown): boolean {
	if (typeof v === 'boolean') return v;
	if (typeof v === 'number') return v !== 0;
	if (typeof v === 'string') return ['1', 'yes', 'true', 'on', 'enabled'].includes(v.toLowerCase());
	return false;
}

function num(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
	return null;
}

/** "2027-01-15 10:00:00" (UTC) to "2027-01-15T10:00:00Z"; '' for anything that is not a date. */
export function isoDate(v: unknown): string {
	if (typeof v !== 'string') return '';
	const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/.exec(v.trim());
	if (!m) return '';
	const iso = `${m[1]}T${m[2] ?? '00:00:00'}Z`;
	return Number.isNaN(Date.parse(iso)) ? '' : iso;
}

function hasControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 0x20) return true;
	return false;
}

/** The part of a record name before the domain: 'www', '*', or '' for the apex. */
export function hostOf(name: string, domain: string): string {
	const n = name.toLowerCase().replace(/\.$/, '');
	const d = domain.toLowerCase();
	if (n === d) return '';
	return n.endsWith('.' + d) ? n.slice(0, -(d.length + 1)) : n;
}

function toDomain(raw: unknown): DomainSummary {
	const d = isObj(raw) ? raw : {};
	const domain = str(d.domain).toLowerCase();
	return {
		domain,
		tld: str(d.tld) || domain.slice(domain.indexOf('.') + 1),
		status: str(d.status),
		createDate: isoDate(d.createDate),
		expireDate: isoDate(d.expireDate),
		autoRenew: flag(d.autoRenew),
		securityLock: flag(d.securityLock),
		whoisPrivacy: flag(d.whoisPrivacy),
		apiAccess: flag(d.apiAccess),
		notLocal: flag(d.notLocal),
		labels: arr(d.labels)
			.filter(isObj)
			.map((l) => ({ id: str(l.id), title: str(l.title), color: str(l.color) }))
	};
}

function toRecord(raw: unknown, domain: string): DnsRecord {
	const r = isObj(raw) ? raw : {};
	const name = str(r.name).toLowerCase() || domain;
	const notes = typeof r.notes === 'string' && r.notes !== '' ? r.notes : null;
	return {
		id: str(r.id),
		name,
		host: hostOf(name, domain),
		type: str(r.type).toUpperCase(),
		content: str(r.content),
		ttl: num(r.ttl) ?? 0,
		prio: num(r.prio),
		notes
	};
}

function toSnapshotRecord(raw: unknown): SnapshotRecord {
	const r = isObj(raw) ? raw : {};
	return {
		name: str(r.name).toLowerCase(),
		type: str(r.type).toUpperCase(),
		content: str(r.content),
		ttl: num(r.ttl) ?? 0,
		prio: num(r.prio)
	};
}

function toScopes(raw: unknown): PorkbunScope[] {
	const given = strings(raw);
	if (given.includes('full')) return [...PORKBUN_SCOPES];
	return PORKBUN_SCOPES.filter((s) => given.includes(s));
}

function toRedirectType(f: Json): RedirectType {
	const exact = str(f.redirectType);
	if (exact === '301' || exact === '302' || exact === '307' || exact === 'masked') return exact;
	const kind = str(f.type);
	return kind === 'permanent' ? '301' : kind === 'masked' ? 'masked' : '302';
}

function recordBody(input: Partial<DnsRecordInput>): Json {
	const body: Json = {};
	if (input.host !== undefined) body.name = input.host;
	if (input.type !== undefined) body.type = input.type;
	if (input.content !== undefined) body.content = input.content;
	if (input.ttl !== undefined) body.ttl = input.ttl;
	if (input.prio !== undefined) body.prio = input.prio;
	if (input.notes !== undefined) body.notes = input.notes;
	return body;
}

// ── The client ───────────────────────────────────────────────────────────────────────────────────────────

export class Porkbun {
	/** True for a `pk1_sb_…` key: Porkbun simulates everything and touches nothing real. */
	readonly sandbox: boolean;
	/** `X-API-Version` of the last answer, for the spec drift check. */
	lastApiVersion: string | undefined;

	readonly #apiKey: string;
	readonly #apiSecret: string;
	readonly #baseUrl: string;
	readonly #fetch: FetchLike;
	readonly #timeoutMs: number;
	readonly #maxRetryAfterMs: number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #newKey: () => string;
	readonly #redact: (text: string) => string;
	readonly #limit: number;
	#active = 0;
	readonly #waiting: (() => void)[] = [];

	constructor(opts: PorkbunOptions) {
		this.#apiKey = opts.apiKey;
		this.#apiSecret = opts.apiSecret;
		this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
		this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
		this.#timeoutMs = opts.timeoutMs ?? 15_000;
		this.#maxRetryAfterMs = opts.maxRetryAfterMs ?? 5_000;
		this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#newKey = opts.newIdempotencyKey ?? randomUUID;
		this.#redact = redactor([opts.apiKey, opts.apiSecret]);
		this.#limit = Math.max(1, opts.concurrency ?? 4);
		this.sandbox = opts.apiKey.startsWith(SANDBOX_KEY_PREFIX);
	}

	/** Blanks this client's keys in a string. The audit log runs every row through it. */
	redact = (text: string): string => this.#redact(text);

	// ── Transport ────────────────────────────────────────────────────────────────────────────────────────

	async #slot<T>(run: () => Promise<T>): Promise<T> {
		if (this.#active >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
		else this.#active++;
		try {
			return await run();
		} finally {
			const next = this.#waiting.shift();
			// Hand the slot straight to the next waiter, so the count never dips below what is running.
			if (next) next();
			else this.#active--;
		}
	}

	#url(segments: readonly string[], query?: Query): string {
		const path = segments
			.map((s) => {
				if (s === '' || s === '.' || s === '..' || hasControlChar(s)) {
					throw new PorkbunError({
						code: 'BAD_REQUEST',
						message: 'A name in the request is empty or not usable in a Porkbun path',
						httpStatus: 400
					});
				}
				return encodeURIComponent(s);
			})
			.join('/');
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
		const tail = qs.size > 0 ? `?${qs}` : '';
		return `${this.#baseUrl}/${path}${tail}`;
	}

	async #once(
		method: 'GET' | 'POST',
		url: string,
		auth: boolean,
		body: Json | undefined,
		key: string | undefined
	): Promise<Reply> {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (auth) {
			headers['x-api-key'] = this.#apiKey;
			headers['x-secret-api-key'] = this.#apiSecret;
		}
		const init: RequestInit = {
			method,
			headers,
			redirect: 'error',
			signal: AbortSignal.timeout(this.#timeoutMs)
		};
		if (method === 'POST') {
			headers['content-type'] = 'application/json';
			headers['idempotency-key'] = key ?? this.#newKey();
			init.body = JSON.stringify(body ?? {});
		}

		let res: Response;
		let text: string;
		try {
			res = await this.#fetch(url, init);
			text = await res.text();
		} catch (err) {
			const name = err instanceof Error ? err.name : '';
			if (name === 'TimeoutError' || name === 'AbortError') {
				throw new PorkbunUnreachable(
					`Porkbun did not answer within ${Math.round(this.#timeoutMs / 1000)} s`,
					'timeout'
				);
			}
			// Only the system error code is kept: an error's message could quote the request.
			const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
			const code =
				typeof cause?.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? ` (${cause.code})` : '';
			throw new PorkbunUnreachable(`Porkbun could not be reached${code}`, 'network');
		}

		this.lastApiVersion = res.headers.get('x-api-version') ?? this.lastApiVersion;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		const data = isObj(parsed) ? redactDeep(parsed, this.#redact) : undefined;
		const requestId = (data && str(data.requestId)) || res.headers.get('x-request-id') || undefined;

		if (res.ok && data && data.status !== 'ERROR') return { body: data, requestId };

		const retryAfter = num(res.headers.get('retry-after')) ?? num(data?.ttlRemaining) ?? undefined;
		if (!data) {
			if (res.status === 429) {
				throw new PorkbunError({
					code: 'RATE_LIMIT_EXCEEDED',
					message: 'Porkbun is rate limiting this key',
					httpStatus: 429,
					retryAfter,
					requestId
				});
			}
			throw new PorkbunUnreachable(`Porkbun answered HTTP ${res.status} without JSON`, 'bad_response');
		}

		const { status: _s, message, code, next_action: na, requestId: _r, ...rest } = data;
		const codeText = str(code) || (res.status === 429 ? 'RATE_LIMIT_EXCEEDED' : `HTTP_${res.status}`);
		let nextAction: NextAction | null = null;
		if (isObj(na)) {
			nextAction = {
				type: str(na.type) || 'none',
				retryable: typeof na.retryable === 'boolean' ? na.retryable : codeText === 'RATE_LIMIT_EXCEEDED'
			};
			if (str(na.hint)) nextAction.hint = str(na.hint);
			if (str(na.url)) nextAction.url = str(na.url);
		}
		throw new PorkbunError({
			code: codeText,
			message: str(message) || `Porkbun refused the request (HTTP ${res.status})`,
			// A 200 that says ERROR is still a refusal of the request as sent.
			httpStatus: res.ok ? 400 : res.status,
			nextAction,
			requestId,
			retryAfter,
			details: rest
		});
	}

	async #get(segments: readonly string[], query?: Query, auth = true): Promise<Reply> {
		const url = this.#url(segments, query);
		return this.#slot(async () => {
			try {
				return await this.#once('GET', url, auth, undefined, undefined);
			} catch (err) {
				if (!(err instanceof PorkbunError) || err.code !== 'RATE_LIMIT_EXCEEDED') throw err;
				const waitMs = (err.retryAfter ?? 1) * 1000;
				if (waitMs > this.#maxRetryAfterMs) throw err;
				await this.#sleep(waitMs);
				return this.#once('GET', url, auth, undefined, undefined);
			}
		});
	}

	async #post(
		segments: readonly string[],
		body: Json | undefined,
		opts: WriteOpts | undefined
	): Promise<Reply> {
		const url = this.#url(segments);
		return this.#slot(() => this.#once('POST', url, true, body, opts?.idempotencyKey));
	}

	async #write(segments: readonly string[], body?: Json, opts?: WriteOpts): Promise<Written> {
		const { body: data, requestId } = await this.#post(segments, body, opts);
		return { warnings: strings(data.warnings), requestId };
	}

	/**
	 * Rehearse a write. A refusal that will not go away by waiting becomes `wouldSucceed: false`; a transient
	 * one (rate limit, no answer) is thrown, because it says nothing about the change itself.
	 */
	async #dryRun(segments: readonly string[], body?: Json): Promise<DryRun> {
		try {
			const { body: data } = await this.#post(segments, { ...body, dryRun: true }, undefined);
			const warnings = strings(data.warnings);
			if (data.wouldSucceed === false) {
				return {
					wouldSucceed: false,
					warnings,
					error: {
						code: str(data.code) || 'WOULD_FAIL',
						message: str(data.message) || 'Porkbun says this change would not succeed',
						retryable: false
					}
				};
			}
			return { wouldSucceed: true, warnings };
		} catch (err) {
			if (err instanceof PorkbunError && !err.retryable) {
				return { wouldSucceed: false, warnings: [], error: toApiError(err) ?? undefined };
			}
			throw err;
		}
	}

	/** Path segments for the `…ByNameType` endpoints; the apex has no last segment. */
	static #byNameType(op: string, domain: string, type: string, host: string): string[] {
		const base = ['dns', op, domain, type];
		return host === '' ? base : [...base, host];
	}

	// ── Connection ───────────────────────────────────────────────────────────────────────────────────────

	/** `/ping`: checks the keys and reports the caller's public IP and the key's permissions. */
	ping = async (): Promise<PingResult> => {
		const { body } = await this.#get(['ping']);
		const account = str(body.account);
		return {
			ip: str(body.yourIp),
			credentialsValid: body.credentialsValid === true,
			...(account ? { account } : {}),
			scopes: toScopes(body.scopes)
		};
	};

	// ── Domains ──────────────────────────────────────────────────────────────────────────────────────────

	readonly domains = {
		/** `/domain/listAll`, every page (1,000 domains each), with labels. */
		list: async (): Promise<DomainSummary[]> => {
			const out: DomainSummary[] = [];
			for (let start = 0; start < 100_000; start += 1000) {
				const { body } = await this.#get(['domain', 'listAll'], { start, includeLabels: 'yes' });
				const page = arr(body.domains);
				out.push(...page.map(toDomain));
				if (page.length < 1000) break;
			}
			return out;
		},

		/** `/domain/get/{domain}`. Throws DOMAIN_NOT_FOUND when it is not in the account. */
		get: async (domain: string): Promise<DomainSummary> => {
			const { body } = await this.#get(['domain', 'get', domain], { includeLabels: 'yes' });
			return toDomain(body.domain);
		},

		/** `/domain/updateAutoRenew` for one or many domains. Reports per domain; one refusal does not throw. */
		setAutoRenew: async (
			domains: readonly string[],
			on: boolean,
			opts?: WriteOpts
		): Promise<Written<{ results: AutoRenewResult[] }>> => {
			const [first, ...rest] = domains;
			if (first === undefined) return { results: [], warnings: [] };
			const body: Json = { status: on ? 'on' : 'off' };
			if (rest.length > 0) body.domains = rest;
			const { body: data, requestId } = await this.#post(['domain', 'updateAutoRenew', first], body, opts);
			const raw = isObj(data.results) ? data.results : {};
			const results = Object.entries(raw).map(([domain, r]) => {
				const row = isObj(r) ? r : {};
				return { domain: domain.toLowerCase(), ok: str(row.status) === 'SUCCESS', message: str(row.message) };
			});
			return { results, warnings: strings(data.warnings), requestId };
		}
	};

	// ── DNS records, restore points, preflight, import ──────────────────────────────────────────────────

	readonly dns = {
		/** `/dns/retrieve/{domain}`: every editable record. */
		list: async (domain: string): Promise<DnsZone> => {
			const { body } = await this.#get(['dns', 'retrieve', domain]);
			return {
				records: arr(body.records).map((r) => toRecord(r, domain)),
				cloudflare: flag(body.cloudflare)
			};
		},

		/** `/dns/retrieve/{domain}/{id}`, or null when Porkbun returns no such record. */
		get: async (domain: string, id: string): Promise<DnsRecord | null> => {
			const { body } = await this.#get(['dns', 'retrieve', domain, id]);
			const first = arr(body.records)[0];
			return first === undefined ? null : toRecord(first, domain);
		},

		/** `/dns/retrieveByNameType/{domain}/{type}/{host}`. `host` '' is the apex. */
		listByNameType: async (domain: string, type: string, host: string): Promise<DnsRecord[]> => {
			const { body } = await this.#get(Porkbun.#byNameType('retrieveByNameType', domain, type, host));
			return arr(body.records).map((r) => toRecord(r, domain));
		},

		/** `/dns/create/{domain}`. The new id is a string, like every other record id. */
		create: async (
			domain: string,
			input: DnsRecordInput,
			opts?: WriteOpts
		): Promise<Written<{ id: string }>> => {
			const { body, requestId } = await this.#post(['dns', 'create', domain], recordBody(input), opts);
			return { id: str(body.id), warnings: strings(body.warnings), requestId };
		},

		/** `/dns/edit/{domain}/{id}`. Only the fields given change; `host: ''` moves the record to the apex. */
		edit: (domain: string, id: string, patch: Partial<DnsRecordInput>, opts?: WriteOpts): Promise<Written> =>
			this.#write(['dns', 'edit', domain, id], recordBody(patch), opts),

		/** `/dns/editByNameType`: sets the content of every record with that host and type. */
		editByNameType: (
			domain: string,
			type: DnsRecordType,
			host: string,
			change: Pick<DnsRecordInput, 'content' | 'ttl' | 'prio' | 'notes'>,
			opts?: WriteOpts
		): Promise<Written> =>
			this.#write(Porkbun.#byNameType('editByNameType', domain, type, host), recordBody(change), opts),

		/** `/dns/delete/{domain}/{id}`. */
		delete: (domain: string, id: string, opts?: WriteOpts): Promise<Written> =>
			this.#write(['dns', 'delete', domain, id], undefined, opts),

		/** `/dns/deleteByNameType`: deletes every record with that host and type. */
		deleteByNameType: (
			domain: string,
			type: DnsRecordType,
			host: string,
			opts?: WriteOpts
		): Promise<Written> =>
			this.#write(Porkbun.#byNameType('deleteByNameType', domain, type, host), undefined, opts),

		/** The same writes with `dryRun: true`: validated by Porkbun, nothing changed. */
		dryRun: {
			create: (domain: string, input: DnsRecordInput): Promise<DryRun> =>
				this.#dryRun(['dns', 'create', domain], recordBody(input)),
			edit: (domain: string, id: string, patch: Partial<DnsRecordInput>): Promise<DryRun> =>
				this.#dryRun(['dns', 'edit', domain, id], recordBody(patch)),
			editByNameType: (
				domain: string,
				type: DnsRecordType,
				host: string,
				change: Pick<DnsRecordInput, 'content' | 'ttl' | 'prio' | 'notes'>
			): Promise<DryRun> =>
				this.#dryRun(Porkbun.#byNameType('editByNameType', domain, type, host), recordBody(change)),
			delete: (domain: string, id: string): Promise<DryRun> => this.#dryRun(['dns', 'delete', domain, id]),
			deleteByNameType: (domain: string, type: DnsRecordType, host: string): Promise<DryRun> =>
				this.#dryRun(Porkbun.#byNameType('deleteByNameType', domain, type, host))
		},

		/** `/dns/history/{domain}`: restore points, newest first (at most 50). */
		history: async (domain: string): Promise<RestorePoint[]> => {
			const { body } = await this.#get(['dns', 'history', domain]);
			return arr(body.restorePoints)
				.filter(isObj)
				.map((p) => ({
					id: num(p.id) ?? 0,
					takenAt: isoDate(p.takenAt),
					reason: str(p.reason),
					source: str(p.source),
					recordCount: num(p.recordCount) ?? 0,
					matchesLive: p.matchesLive === true
				}));
		},

		/** `/dns/diff/{domain}/{snapshotId}`: a restore point against the live zone. */
		diff: async (domain: string, snapshotId: number): Promise<ZoneDiff> => {
			const { body } = await this.#get(['dns', 'diff', domain, String(snapshotId)]);
			const snap = isObj(body.snapshot) ? body.snapshot : {};
			return {
				snapshot: {
					id: num(snap.id) ?? snapshotId,
					takenAt: isoDate(snap.takenAt),
					reason: str(snap.reason)
				},
				missing: arr(body.missing).map(toSnapshotRecord),
				extra: arr(body.extra).map(toSnapshotRecord),
				inSync: body.inSync === true
			};
		},

		/**
		 * `/dns/restore/{domain}`. By default only adds back what is missing; `prune` also deletes records added
		 * since. With `dryRun` it reports what would change and changes nothing.
		 */
		restore: async (
			domain: string,
			snapshotId: number,
			o: { prune?: boolean; dryRun?: boolean } & WriteOpts = {}
		): Promise<Written<RestoreResult>> => {
			const body: Json = { snapshotId, prune: o.prune === true };
			if (o.dryRun) body.dryRun = true;
			const { body: data, requestId } = await this.#post(['dns', 'restore', domain], body, o);
			return {
				dryRun: o.dryRun === true,
				restoredFrom: num(data.restoredFrom) ?? snapshotId,
				previousStateSavedAs: num(data.previousStateSavedAs),
				restored: num(data.restored) ?? 0,
				removed: num(data.removed) ?? 0,
				failed: arr(data.failed)
					.filter(isObj)
					.map((f) => ({ name: str(f.name), type: str(f.type), reason: str(f.reason) })),
				warnings: strings(data.warnings),
				requestId
			};
		},

		/** `/dns/preflight/{domain}`: would a change break the domain? Read-only. */
		preflight: async (domain: string, intent: PreflightIntent = 'general'): Promise<Preflight> => {
			const { body } = await this.#get(['dns', 'preflight', domain], { intent });
			const checks: PreflightCheck[] = arr(body.checks)
				.filter(isObj)
				.map((c) => {
					const severity = str(c.severity);
					const check: PreflightCheck = {
						id: str(c.id),
						severity: severity === 'blocker' || severity === 'warning' ? severity : 'info',
						ok: c.ok === true,
						title: str(c.title),
						detail: str(c.detail)
					};
					if (str(c.next_action)) check.nextAction = str(c.next_action);
					return check;
				});
			return {
				intent: str(body.intent) || intent,
				safe: body.safe === true,
				blockers: strings(body.blockers),
				warnings: strings(body.warnings),
				checks
			};
		},

		/** `/dns/scan/{domain}`: what the domain's current nameservers publish. Limited to 20 calls an hour. */
		scan: async (domain: string): Promise<ImportRecord[]> => {
			const { body } = await this.#get(['dns', 'scan', domain]);
			return arr(body.records)
				.filter(isObj)
				.map((r) => {
					const rec: ImportRecord = {
						host: str(r.name),
						type: str(r.type).toUpperCase(),
						content: str(r.content)
					};
					const ttl = num(r.ttl);
					const prio = num(r.prio);
					if (ttl !== null) rec.ttl = ttl;
					if (prio !== null) rec.prio = prio;
					return rec;
				});
		},

		/**
		 * `/dns/import/{domain}`: create many records in one call (at most 500). Records that already exist are
		 * counted as skipped. Pass 'scan' to import whatever a scan discovers.
		 */
		import: async (
			domain: string,
			records: readonly ImportRecord[] | 'scan',
			o: { dryRun?: boolean } & WriteOpts = {}
		): Promise<Written<ImportResult>> => {
			const body: Json = {};
			if (records !== 'scan') {
				body.records = records.map((r) => {
					const out: Json = { name: r.host, type: r.type, content: r.content };
					if (r.ttl !== undefined) out.ttl = r.ttl;
					if (r.prio !== undefined) out.prio = r.prio;
					return out;
				});
			}
			if (o.dryRun) body.dryRun = true;
			const { body: data, requestId } = await this.#post(['dns', 'import', domain], body, o);
			return {
				dryRun: o.dryRun === true,
				created: num(data.created) ?? 0,
				skipped: num(data.skipped) ?? 0,
				failed: num(data.failed) ?? 0,
				failures: arr(data.failures),
				warnings: strings(data.warnings),
				requestId
			};
		}
	};

	// ── DNSSEC ───────────────────────────────────────────────────────────────────────────────────────────

	readonly dnssec = {
		/** `/dns/getDnssecRecords/{domain}`: the DS records at the registry. */
		list: async (domain: string): Promise<DnssecRecord[]> => {
			const { body } = await this.#get(['dns', 'getDnssecRecords', domain]);
			const raw = isObj(body.records) ? body.records : {};
			return Object.entries(raw).map(([key, v]) => {
				const r = isObj(v) ? v : {};
				const rec: DnssecRecord = {
					keyTag: str(r.keyTag) || key,
					alg: str(r.alg),
					digestType: str(r.digestType),
					digest: str(r.digest)
				};
				if (str(r.pubKey)) rec.pubKey = str(r.pubKey);
				return rec;
			});
		},

		/** `/dns/createDnssecRecord/{domain}`. */
		create: (domain: string, input: DnssecInput, opts?: WriteOpts): Promise<Written> =>
			this.#write(['dns', 'createDnssecRecord', domain], { ...input }, opts),

		/** `/dns/deleteDnssecRecord/{domain}/{keyTag}`. Most registries delete every record with that key data. */
		delete: (domain: string, keyTag: string, opts?: WriteOpts): Promise<Written> =>
			this.#write(['dns', 'deleteDnssecRecord', domain, keyTag], undefined, opts)
	};

	// ── Nameservers ──────────────────────────────────────────────────────────────────────────────────────

	readonly ns = {
		/** `/domain/getNs/{domain}`: lower case and sorted, because nameservers are a set. */
		get: async (domain: string): Promise<string[]> => {
			const { body } = await this.#get(['domain', 'getNs', domain]);
			return strings(body.ns)
				.map((n) => n.toLowerCase().replace(/\.$/, ''))
				.sort();
		},

		/** `/domain/updateNs/{domain}`: replaces the whole set at the registry. */
		update: (domain: string, ns: readonly string[], opts?: WriteOpts): Promise<Written> =>
			this.#write(['domain', 'updateNs', domain], { ns: [...ns] }, opts),

		dryRunUpdate: (domain: string, ns: readonly string[]): Promise<DryRun> =>
			this.#dryRun(['domain', 'updateNs', domain], { ns: [...ns] })
	};

	// ── Glue records ─────────────────────────────────────────────────────────────────────────────────────

	readonly glue = {
		/** `/domain/getGlue/{domain}`. */
		list: async (domain: string): Promise<GlueHost[]> => {
			const { body } = await this.#get(['domain', 'getGlue', domain]);
			if (Array.isArray(body.glue)) {
				return body.glue.filter(isObj).map((g) => ({
					host: str(g.host).toLowerCase(),
					v4: strings(g.v4),
					v6: strings(g.v6)
				}));
			}
			// Before API 3.72 only `hosts` existed: [hostname, { v4, v6 }] pairs.
			return arr(body.hosts)
				.filter((h): h is unknown[] => Array.isArray(h) && typeof h[0] === 'string')
				.map((h) => {
					const ips = isObj(h[1]) ? h[1] : {};
					return { host: str(h[0]).toLowerCase(), v4: strings(ips.v4), v6: strings(ips.v6) };
				});
		},

		/** `/domain/createGlue/{domain}/{host}`. `host` is the part before the domain, for example 'ns1'. */
		create: (domain: string, host: string, ips: readonly string[], opts?: WriteOpts): Promise<Written> =>
			this.#write(['domain', 'createGlue', domain, host], { ips: [...ips] }, opts),

		/** `/domain/updateGlue/{domain}/{host}`: replaces every address of the host. */
		update: (domain: string, host: string, ips: readonly string[], opts?: WriteOpts): Promise<Written> =>
			this.#write(['domain', 'updateGlue', domain, host], { ips: [...ips] }, opts),

		/** `/domain/deleteGlue/{domain}/{host}`. */
		delete: (domain: string, host: string, opts?: WriteOpts): Promise<Written> =>
			this.#write(['domain', 'deleteGlue', domain, host], undefined, opts)
	};

	// ── URL forwarding ───────────────────────────────────────────────────────────────────────────────────

	readonly forwards = {
		/** `/domain/getUrlForwarding/{domain}`. */
		list: async (domain: string): Promise<UrlForward[]> => {
			const { body } = await this.#get(['domain', 'getUrlForwarding', domain]);
			return arr(body.forwards)
				.filter(isObj)
				.map((f) => ({
					id: str(f.id),
					subdomain: str(f.subdomain),
					location: str(f.location),
					redirectType: toRedirectType(f),
					includePath: flag(f.includePath),
					wildcard: flag(f.wildcard)
				}));
		},

		/** `/domain/addUrlForward/{domain}`. */
		add: (domain: string, input: UrlForwardInput, opts?: WriteOpts): Promise<Written> => {
			const kind =
				input.redirectType === '301' ? 'permanent' : input.redirectType === 'masked' ? 'masked' : 'temporary';
			return this.#write(
				['domain', 'addUrlForward', domain],
				{
					subdomain: input.subdomain,
					location: input.location,
					type: kind,
					redirectType: input.redirectType,
					includePath: input.includePath ? 'yes' : 'no',
					wildcard: input.wildcard ? 'yes' : 'no'
				},
				opts
			);
		},

		/** `/domain/deleteUrlForward/{domain}/{id}`. */
		delete: (domain: string, id: string, opts?: WriteOpts): Promise<Written> =>
			this.#write(['domain', 'deleteUrlForward', domain, id], undefined, opts)
	};

	// ── SSL bundle ───────────────────────────────────────────────────────────────────────────────────────

	readonly ssl = {
		/**
		 * `/ssl/retrieve/{domain}`: the certificate Porkbun issued. The result holds the private key, so it
		 * must not be cached, logged or audited.
		 */
		retrieve: async (domain: string): Promise<SslBundle> => {
			const { body } = await this.#get(['ssl', 'retrieve', domain]);
			return {
				certificateChain: str(body.certificatechain),
				privateKey: str(body.privatekey),
				publicKey: str(body.publickey)
			};
		}
	};

	// ── Pricing and account ──────────────────────────────────────────────────────────────────────────────

	readonly pricing = {
		/** `/pricing/get`: public, so it is sent without the keys. No argument returns every TLD. */
		get: async (tlds?: readonly string[]): Promise<Pricing> => {
			const query = tlds && tlds.length > 0 ? { tlds: tlds.join(',') } : undefined;
			const { body } = await this.#get(['pricing', 'get'], query, false);
			const raw = isObj(body.pricing) ? body.pricing : {};
			const out: Pricing = {};
			for (const [tld, v] of Object.entries(raw)) {
				if (!isObj(v)) continue;
				out[tld] = { registration: str(v.registration), renewal: str(v.renewal), transfer: str(v.transfer) };
				if (str(v.specialType)) (out[tld] as { specialType?: string }).specialType = str(v.specialType);
			}
			return out;
		}
	};

	readonly account = {
		/** `/account/balance`: prepaid credit. */
		balance: async (): Promise<AccountBalance> => {
			const { body } = await this.#get(['account', 'balance']);
			return { cents: num(body.balance) ?? 0, display: str(body.display) };
		},

		/** `/account/apiSettings`: the account's API spend controls. Amounts in cents. */
		apiSettings: async (): Promise<SpendSettings> => {
			const { body } = await this.#get(['account', 'apiSettings']);
			const s = isObj(body.settings) ? body.settings : {};
			const limit = isObj(body.spendLimit) ? body.spendLimit : null;
			return {
				monthlySpendLimit: num(s.monthlySpendLimit),
				lowBalanceAlert: num(s.lowBalanceAlert),
				autoTopup: flag(s.autoTopup),
				monthlySpend: num(body.monthlySpend) ?? 0,
				spendLimit: limit
					? {
							limit: num(limit.limit),
							source: str(limit.source),
							spent: num(limit.spent) ?? 0,
							remaining: num(limit.remaining)
						}
					: null
			};
		}
	};
}
