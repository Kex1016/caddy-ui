import { error } from '@sveltejs/kit';
import type { ApiError, DnsRecordInput, DryRun, PorkbunFailure, WriteResult } from '$lib/api/porkbun';
import type {
	ChallengeCleanupPreview,
	ChallengeCleanupRequest,
	ChallengeCleanupResult,
	RecordFix,
	RecordFixPreview,
	RecordFixRequest,
	RecordFixResult
} from '$lib/api/porkbun-caddy';
import { listDomains, porkbun, porkbunStatus, requireDomain, requireWritable, write } from '../../porkbun';
import { siteHost } from './caddyfile';
import { caddyTieIn } from './check';
import { domainOf, fqdn } from './resolve';

/**
 * The two writes of the Caddy tie-in (docs/porkbun-plan.md §4), both through `write()` and so through
 * read-only mode, the key's scope, the cache and the activity log:
 *
 * - make a site's name point at this server (create the record, or change the one record that is wrong);
 * - delete challenge records Caddy left behind.
 *
 * Neither takes record contents from the browser. The server works out the change from the Caddyfile and the
 * zone as they are now; the browser only says which site address, and which change the person reviewed.
 */

/** A refusal of this API's own, in the shape every `/api/porkbun/*` route answers with. */
export class TieInRefusal extends Error {
	constructor(
		readonly status: number,
		readonly body: PorkbunFailure & { fix?: RecordFix }
	) {
		super(body.message);
		this.name = 'TieInRefusal';
	}
}

function refuse(status: number, code: string, message: string, extra: { fix?: RecordFix } = {}): never {
	const apiError: ApiError = { code, message, retryable: false };
	throw new TieInRefusal(status, { message, code, error: apiError, ...extra });
}

const sameFix = (a: RecordFix, b: RecordFix): boolean =>
	a.kind === b.kind &&
	a.domain === b.domain &&
	a.host === b.host &&
	a.type === b.type &&
	a.content === b.content &&
	(a.id ?? '') === (b.id ?? '') &&
	(a.before ?? '') === (b.before ?? '');

export function parseFixRequest(body: unknown): RecordFixRequest {
	if (!body || typeof body !== 'object' || Array.isArray(body))
		refuse(400, 'BAD_REQUEST', 'Send a JSON object');
	const b = body as Record<string, unknown>;
	if (typeof b.host !== 'string' || siteHost(b.host) === null) {
		refuse(400, 'BAD_REQUEST', '"host" must be a site address such as app.example.com');
	}
	const out: RecordFixRequest = { host: fqdn(b.host as string), dryRun: b.dryRun === true };
	if (b.expect !== undefined) {
		const e = b.expect as Partial<RecordFix> | null;
		const ok =
			e !== null &&
			typeof e === 'object' &&
			(e.kind === 'create' || e.kind === 'edit') &&
			(e.type === 'A' || e.type === 'AAAA') &&
			[e.domain, e.host, e.content].every((v) => typeof v === 'string') &&
			[e.id, e.before].every((v) => v === undefined || typeof v === 'string');
		if (!ok) refuse(400, 'BAD_REQUEST', '"expect" must be the fix that was reviewed');
		out.expect = e as RecordFix;
	}
	return out;
}

/**
 * Create or fix the record a site needs. With `dryRun`, Porkbun validates the change and nothing changes.
 * Refuses with 404 when the address is not a site or not under a domain of the account, and with 409 when
 * there is nothing one record change can fix or the records changed since the review.
 */
export async function fixSiteRecord(
	req: RecordFixRequest,
	author: string
): Promise<RecordFixPreview | RecordFixResult> {
	const pb = porkbun();
	const account = await listDomains();
	const name = domainOf(
		req.host,
		account.data.map((d) => d.domain)
	);
	if (name === null) {
		error(404, {
			message: `${req.host} is not under a domain in this Porkbun account`,
			code: 'DOMAIN_NOT_IN_ACCOUNT'
		});
	}
	const domain = await requireDomain(name);
	const tie = await caddyTieIn({ domain: domain.domain, host: req.host, freshZones: true });
	const check = tie.sites.find((s) => s.host === req.host);
	if (!check) refuse(404, 'SITE_NOT_FOUND', `${req.host} is not a site address in the Caddyfile`);
	const fix = check.fix;
	if (!fix) refuse(409, 'NOTHING_TO_FIX', check.detail);
	if (req.expect && !sameFix(req.expect, fix)) {
		refuse(409, 'RECORDS_CHANGED', 'The records changed since this was reviewed. Review the change again.', {
			fix
		});
	}

	await porkbunStatus();
	requireWritable('dns');
	const input: DnsRecordInput = {
		host: fix.host,
		type: fix.type,
		content: fix.content,
		notes: `Site ${req.host} in Caddy (set by Caddy UI)`
	};
	if (req.dryRun) {
		const dryRun =
			fix.kind === 'create'
				? await pb.dns.dryRun.create(domain.domain, input)
				: await pb.dns.dryRun.edit(domain.domain, fix.id as string, { content: fix.content });
		return { fix, dryRun };
	}
	const result: WriteResult<{ id?: string }> =
		fix.kind === 'create'
			? await write<{ id: string }>({
					scope: 'dns',
					author,
					domain: domain.domain,
					action: 'dns.create',
					request: { ...input, site: req.host },
					run: (client) => client.dns.create(domain.domain, input)
				})
			: await write({
					scope: 'dns',
					author,
					domain: domain.domain,
					action: 'dns.edit',
					request: { id: fix.id, content: fix.content, site: req.host },
					before: check.records.find((r) => r.id === fix.id) ?? { id: fix.id, content: fix.before },
					run: (client) => client.dns.edit(domain.domain, fix.id as string, { content: fix.content })
				});
	return { fix, result };
}

const MAX_CLEANUP = 100;

export function parseCleanupRequest(body: unknown): ChallengeCleanupRequest {
	if (!body || typeof body !== 'object' || Array.isArray(body))
		refuse(400, 'BAD_REQUEST', 'Send a JSON object');
	const b = body as Record<string, unknown>;
	if (typeof b.domain !== 'string') refuse(400, 'BAD_REQUEST', '"domain" must be a domain name');
	const ids = b.ids;
	if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CLEANUP) {
		refuse(400, 'BAD_REQUEST', `"ids" must list 1 to ${MAX_CLEANUP} record ids`);
	}
	if (!(ids as unknown[]).every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))) {
		refuse(400, 'BAD_REQUEST', '"ids" must be record ids');
	}
	return { domain: b.domain as string, ids: [...new Set(ids as string[])], dryRun: b.dryRun === true };
}

/**
 * Delete challenge records that were left behind. Each id is checked against the zone as it is now: it must
 * still be a `_acme-challenge` TXT record of the domain, and one this UI has seen for more than a day.
 * Anything else is refused for that id and the rest goes on. Reports per record. With `dryRun`, Porkbun
 * validates each delete, nothing is deleted, and the answer is one rehearsal for all of them.
 */
export async function cleanChallenges(
	req: ChallengeCleanupRequest,
	author: string,
	now = Date.now()
): Promise<ChallengeCleanupResult | ChallengeCleanupPreview> {
	const domain = await requireDomain(req.domain);
	await porkbunStatus();
	requireWritable('dns');
	const pb = porkbun();
	const tie = await caddyTieIn({ domain: domain.domain, freshZones: true, now });
	const results: ChallengeCleanupResult['results'] = [];
	const rehearsal: DryRun = { wouldSucceed: true, warnings: [] };
	for (const id of req.ids) {
		const record = tie.challenges.find((c) => c.id === id);
		const no = (code: string, message: string) => {
			const error: ApiError = { code, message, retryable: false };
			results.push({ id, name: record?.name ?? '', result: { ok: false, error } });
			rehearsal.wouldSucceed = false;
			rehearsal.error ??= error;
		};
		if (!record) {
			no('NOT_A_CHALLENGE', 'This is no longer a challenge record of the domain. Nothing was deleted.');
			continue;
		}
		if (!record.stale) {
			no(
				'CHALLENGE_IN_USE',
				'This record was first seen less than a day ago, so a certificate order may still need it. Nothing was deleted.'
			);
			continue;
		}
		if (req.dryRun) {
			const one = await pb.dns.dryRun.delete(domain.domain, id);
			rehearsal.warnings.push(...one.warnings.filter((w) => !rehearsal.warnings.includes(w)));
			if (!one.wouldSucceed) {
				rehearsal.wouldSucceed = false;
				rehearsal.error ??= one.error;
			}
			continue;
		}
		const result = await write({
			scope: 'dns',
			author,
			domain: domain.domain,
			action: 'dns.delete',
			request: { id, name: record.name, reason: 'challenge record left behind by Caddy' },
			before: { id, name: record.name, type: 'TXT', content: record.content },
			run: (client) => client.dns.delete(domain.domain, id)
		});
		results.push({ id, name: record.name, result });
	}
	return req.dryRun ? { dryRun: rehearsal } : { results };
}
