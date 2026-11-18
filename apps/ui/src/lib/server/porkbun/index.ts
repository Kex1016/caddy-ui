import { error } from '@sveltejs/kit';
import {
	writeBlock,
	type ApiError,
	type AuditList,
	type Cached,
	type DomainSummary,
	type PorkbunScope,
	type PorkbunStatus,
	type WriteResult,
	type Written
} from '$lib/api/porkbun';
import { getDb, type Db } from '../db';
import { config, type PorkbunConfig } from '../env';
import { insertAudit, listAudit, type AuditInput } from './audit';
import { PorkbunCache } from './cache';
import { Porkbun, SANDBOX_KEY_PREFIX, type FetchLike } from './client';
import { PorkbunError, PorkbunNotConfigured, PorkbunUnreachable, redactor, toApiError } from './errors';

/**
 * The Porkbun module's front door (docs/porkbun-plan.md §3.2). Routes and page loads import from here; only
 * `client.ts` performs HTTP. See README.md in this folder for how the pieces are meant to be used.
 */

export { Porkbun } from './client';
export type { PingResult, WriteOpts } from './client';
export { PorkbunError, PorkbunNotConfigured, PorkbunUnreachable, toApiError, toResponse } from './errors';
export type { AuditInput } from './audit';

type State = {
	settings: PorkbunConfig;
	fetch: FetchLike | undefined;
	db: Db | undefined;
	now: () => number;
	client: Porkbun | undefined;
	cache: PorkbunCache | undefined;
	status: { value: PorkbunStatus; at: number } | undefined;
	pinging: Promise<PorkbunStatus> | undefined;
};

let state: State | undefined;

function current(): State {
	state ??= {
		settings: config().porkbun,
		fetch: undefined,
		db: undefined,
		now: Date.now,
		client: undefined,
		cache: undefined,
		status: undefined,
		pinging: undefined
	};
	return state;
}

const db = (s: State): Db => s.db ?? getDb();

function cache(s: State): PorkbunCache {
	s.cache ??= new PorkbunCache(db(s), s.settings.cacheTtlMs, s.now);
	return s.cache;
}

function missing(settings: PorkbunConfig): 'PORKBUN_API_KEY' | 'PORKBUN_API_SECRET_KEY' | 'both' | null {
	if (settings.apiKey && settings.apiSecret) return null;
	if (!settings.apiKey && !settings.apiSecret) return 'both';
	return settings.apiKey ? 'PORKBUN_API_SECRET_KEY' : 'PORKBUN_API_KEY';
}

/** Whether both keys are set, so calls can be made. Page loads check this before anything else. */
export function isConfigured(): boolean {
	return missing(current().settings) === null;
}

/** The process-wide client. Throws `PorkbunNotConfigured` unless both keys are set. */
export function porkbun(): Porkbun {
	const s = current();
	const lacking = missing(s.settings);
	if (lacking) throw new PorkbunNotConfigured(lacking);
	s.client ??= new Porkbun({
		apiKey: s.settings.apiKey as string,
		apiSecret: s.settings.apiSecret as string,
		baseUrl: s.settings.apiUrl,
		...(s.fetch ? { fetch: s.fetch } : {})
	});
	return s.client;
}

/** How long a failed `/ping` is remembered, so a broken key does not cost a request per page view. */
const STATUS_ERROR_TTL_MS = 10_000;
const STATUS_MIN_TTL_MS = 10_000;

async function ping(s: State): Promise<PorkbunStatus> {
	const sandbox = s.settings.apiKey?.startsWith(SANDBOX_KEY_PREFIX) ?? false;
	const base = { sandbox, readonly: s.settings.readonly };
	try {
		const res = await porkbun().ping();
		const status: PorkbunStatus = { state: 'ok', ...base, scopes: res.scopes, checkedAt: s.now() };
		if (res.ip) status.publicIp = res.ip;
		if (res.account) status.account = res.account;
		return status;
	} catch (err) {
		const apiError = toApiError(err);
		if (!apiError) throw err;
		// Keep what the last good answer said, so controls do not flip while Porkbun is briefly away.
		const last = s.status?.value;
		const status: PorkbunStatus = { state: 'error', ...base, scopes: last?.scopes ?? [], error: apiError };
		if (last?.publicIp) status.publicIp = last.publicIp;
		if (last?.account) status.account = last.account;
		if (last?.checkedAt) status.checkedAt = last.checkedAt;
		return status;
	}
}

/**
 * What the Domains area can do right now. With the keys unset this makes no call. Otherwise it asks `/ping`
 * and remembers the answer for the cache TTL (a failure for ten seconds); `force` asks again now.
 */
export async function porkbunStatus(opts: { force?: boolean } = {}): Promise<PorkbunStatus> {
	const s = current();
	const lacking = missing(s.settings);
	if (lacking === 'both') return { state: 'off', sandbox: false, readonly: s.settings.readonly, scopes: [] };
	if (lacking) {
		return {
			state: 'misconfigured',
			missing: lacking,
			sandbox: false,
			readonly: s.settings.readonly,
			scopes: []
		};
	}
	if (s.status && !opts.force) {
		const ttl =
			s.status.value.state === 'ok'
				? Math.max(s.settings.cacheTtlMs, STATUS_MIN_TTL_MS)
				: STATUS_ERROR_TTL_MS;
		if (s.now() - s.status.at < ttl) return s.status.value;
	}
	s.pinging ??= ping(s)
		.then((value) => {
			s.status = { value, at: s.now() };
			return value;
		})
		.finally(() => {
			s.pinging = undefined;
		});
	return s.pinging;
}

/** Cache a read. Keys are `<domain>:<area>` or `_account:<area>`; see cache.ts. */
export function cached<T>(
	key: string,
	load: () => Promise<T>,
	opts?: { force?: boolean }
): Promise<Cached<T>> {
	return cache(current()).cached(key, load, opts);
}

/** Drop cached reads at or below each prefix: `invalidate('example.com:dns')`, `invalidate('example.com')`. */
export function invalidate(...prefixes: string[]): void {
	cache(current()).invalidate(...prefixes);
}

export const DOMAINS_KEY = '_account:domains';

/** Every domain in the account, cached. The list `requireDomain` checks names against. */
export function listDomains(opts?: { force?: boolean }): Promise<Cached<DomainSummary[]>> {
	const pb = porkbun();
	return cached(DOMAINS_KEY, () => pb.domains.list(), opts);
}

const DOMAIN_NAME =
	/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** A name missing from a list this fresh is not looked up again. */
const RECHECK_AFTER_MS = 5_000;

/**
 * The domain a route parameter names, or a 404. A name is only ever sent to Porkbun after it was found in the
 * account's own domain list, so a crafted parameter can not reach another endpoint or another account's
 * domain. Throws `PorkbunNotConfigured` when the keys are unset.
 */
export async function requireDomain(name: string): Promise<DomainSummary> {
	const s = current();
	const wanted = name.trim().toLowerCase().replace(/\.$/, '');
	const notFound = (): never =>
		error(404, {
			message: `${wanted || 'That'} is not a domain in this Porkbun account`,
			code: 'DOMAIN_NOT_IN_ACCOUNT'
		});
	porkbun();
	if (!DOMAIN_NAME.test(wanted)) notFound();
	let list = await listDomains();
	let found = list.data.find((d) => d.domain === wanted);
	if (!found && !list.stale && s.now() - list.fetchedAt > RECHECK_AFTER_MS) {
		// It may have been registered or transferred in since the list was read.
		list = await listDomains({ force: true });
		found = list.data.find((d) => d.domain === wanted);
	}
	return found ?? notFound();
}

/**
 * Refuse a write that is not allowed: 403 in read-only mode, or when the key is known to lack `scope`.
 * Synchronous, so it can not be forgotten behind a missing `await`. The key's scopes are those of the last
 * `/ping` (`porkbunStatus`); before the first one, Porkbun itself refuses what the key may not do.
 */
export function requireWritable(scope: PorkbunScope): void {
	const s = current();
	porkbun();
	const known = s.status?.value;
	const block = writeBlock(
		{ state: known?.state ?? 'error', readonly: s.settings.readonly, scopes: known?.scopes ?? [] },
		scope
	);
	if (block) error(403, { message: block.message, code: block.code });
}

/** Append to the write log. Returns the row id, which `WriteResult.auditId` carries to the browser. */
export function audit(entry: AuditInput): number {
	const s = current();
	return insertAudit(db(s), entry, redactor([s.settings.apiKey, s.settings.apiSecret]), s.now());
}

/** The activity list, newest first. */
export function auditLog(opts?: { domain?: string; limit?: number; before?: number }): AuditList {
	return listAudit(db(current()), opts);
}

export type WriteSpec<T extends object> = {
	/** The permission the write needs at Porkbun: `dns` for records and forwards, `domains` for the rest. */
	scope: PorkbunScope;
	/** `authorOf(locals)` from `$lib/server/config/http`. */
	author: string;
	/** The domain (already through `requireDomain`), or '' for an account-wide action. */
	domain: string;
	/** Dotted, area first: `dns.create`. */
	action: string;
	/** What is being asked, in this UI's terms. Goes to the write log. */
	request: unknown;
	/** The state the write replaces, when it was read. Goes to the write log. */
	before?: unknown;
	/** Cache prefixes the write touches. Default: everything cached for `domain`. */
	invalidate?: string[];
	run: (pb: Porkbun) => Promise<Written<T>>;
};

/**
 * Do one write the way every write must be done: check read-only mode and the key's scope, send it, drop
 * the cached reads it touches, and record it in the write log whether it worked or not.
 *
 * A refusal by Porkbun or a lost connection comes back as `{ ok: false, error }`, not as an exception: the
 * caller usually has more items to apply and a result to show. After a lost connection the write may or may
 * not have happened, so the cache is dropped then too. A 403 from `requireWritable` is thrown.
 */
export async function write<T extends object = object>(spec: WriteSpec<T>): Promise<WriteResult<T>> {
	const pb = porkbun();
	await porkbunStatus();
	requireWritable(spec.scope);
	const touched = spec.invalidate ?? (spec.domain ? [spec.domain] : []);
	const entry = {
		author: spec.author,
		domain: spec.domain,
		action: spec.action,
		request: spec.request,
		before: spec.before
	};
	try {
		const { warnings, requestId, ...data } = await spec.run(pb);
		invalidate(...touched);
		const auditId = audit({ ...entry, ok: true, result: { ...data, warnings }, requestId });
		return { ok: true, data: data as unknown as T, warnings, auditId };
	} catch (err) {
		if (!(err instanceof PorkbunError) && !(err instanceof PorkbunUnreachable)) throw err;
		invalidate(...touched);
		const apiError = toApiError(err) as ApiError;
		const auditId = audit({
			...entry,
			ok: false,
			result: { error: apiError },
			requestId: apiError.requestId
		});
		return { ok: false, error: apiError, auditId };
	}
}

/**
 * Tests only: run the module against the given settings, `fetch` and database instead of the environment.
 * Pass `undefined` to go back to the environment. Every call starts from a clean slate (no client, cache or
 * remembered status). `testing.ts` wraps this for the common case.
 */
export function configurePorkbunForTests(
	opts: { settings: PorkbunConfig; fetch?: FetchLike; db?: Db; now?: () => number } | undefined
): void {
	state = opts
		? {
				settings: opts.settings,
				fetch: opts.fetch,
				db: opts.db,
				now: opts.now ?? Date.now,
				client: undefined,
				cache: undefined,
				status: undefined,
				pinging: undefined
			}
		: undefined;
}
