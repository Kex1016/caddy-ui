import { json } from '@sveltejs/kit';
import type { ApiError, Cached, DnsZone, ImportResult, WriteResult } from '$lib/api/porkbun';
import {
	PorkbunError,
	PorkbunUnreachable,
	cached,
	porkbun,
	porkbunStatus,
	requireWritable,
	toApiError,
	toResponse,
	write
} from '$lib/server/porkbun';
import { IMPORT_LIMIT, classifyImport, countVerdicts, sendable } from './import';
import { normaliseHost } from './names';
import { patchOf, planChanges } from './plan';
import type {
	BatchItem,
	BatchItemStatus,
	BatchResult,
	ImportCandidate,
	ImportReview,
	InvalidRecord,
	PlanRefusal,
	PlannedChange,
	Preview,
	PreviewItem,
	RecordChange,
	RecordSnapshot
} from './types';
import { parseImportText, parseJsonRecords, type ParsedSource } from './zonefile';

/**
 * The server side of the DNS records tab: everything the `/api/porkbun/domains/:d/dns/*` routes do beyond
 * reading their request. Reads go through the Porkbun module's cache, writes through its `write()`, so
 * read-only mode, the key's permission and the write log hold here without being repeated.
 *
 * A change is never sent on the strength of what the browser believes the zone looks like. Every preview and
 * every apply starts from a fresh read, plans the changes against it (`planChanges`) and refuses the lot when
 * one of them has a problem: nothing is sent unless everything can be.
 */

/** Most changes one batch may carry. Larger sets of new records go through the import, which is one call. */
export const MAX_BATCH = 100;
/** Most records one import source may hold, counted before any is sorted out. */
export const MAX_IMPORT_SOURCE = 2000;
export const MAX_IMPORT_BYTES = 1024 * 1024;

/** An answer that is not a failure of Porkbun: the request itself can not be done as asked. */
export class Refusal extends Error {
	constructor(
		readonly status: number,
		readonly body: { message: string; code: string } & Record<string, unknown>
	) {
		super(body.message);
		this.name = 'Refusal';
	}
}

const noStore = { 'cache-control': 'no-store' };

/** For the `catch` of a route: a `Refusal` as its JSON, anything else through the Porkbun module's mapping. */
export function respond(err: unknown): Response {
	if (err instanceof Refusal) return json(err.body, { status: err.status, headers: noStore });
	return toResponse(err);
}

const bad = (message: string, extra: Record<string, unknown> = {}): never => {
	throw new Refusal(400, { message, code: 'BAD_REQUEST', ...extra });
};

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** The JSON body of a request. `optional` lets a request without a body through as `{}`. */
export async function readJson(
	request: Request,
	opts: { maxBytes?: number; optional?: boolean } = {}
): Promise<unknown> {
	let text: string;
	try {
		text = await request.text();
	} catch {
		return bad('The request body could not be read');
	}
	if (Buffer.byteLength(text, 'utf8') > (opts.maxBytes ?? 256 * 1024)) {
		return bad('The request body is too large');
	}
	if (opts.optional && text.trim() === '') return {};
	try {
		return JSON.parse(text);
	} catch {
		return bad('Send a JSON body');
	}
}

// ── Reading the zone ─────────────────────────────────────────────────────────────────────────────────────

export const zoneKey = (domain: string) => `${domain}:dns`;

export function readZone(domain: string, opts?: { force?: boolean }): Promise<Cached<DnsZone>> {
	return cached(zoneKey(domain), () => porkbun().dns.list(domain), opts);
}

/**
 * The zone as Porkbun has it now. A cached copy is not good enough to plan a write against, so when Porkbun
 * can not be asked this fails instead of handing back the last good read.
 */
async function freshZone(domain: string): Promise<Cached<DnsZone>> {
	const zone = await readZone(domain, { force: true });
	if (zone.stale) {
		throw new PorkbunUnreachable(
			'Porkbun could not be reached, so the zone could not be read and nothing was changed',
			'network'
		);
	}
	return zone;
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────────────

const RECORD_ID = /^\d{1,20}$/;

export function requireRecordId(id: string): string {
	if (!RECORD_ID.test(id))
		throw new Refusal(404, { message: 'There is no such record', code: 'INVALID_RECORD_ID' });
	return id;
}

function parseExpect(raw: unknown, at: string): RecordSnapshot | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (
		!isObj(raw) ||
		typeof raw.host !== 'string' ||
		typeof raw.type !== 'string' ||
		typeof raw.content !== 'string' ||
		typeof raw.ttl !== 'number' ||
		!(raw.prio === null || typeof raw.prio === 'number') ||
		!(raw.notes === null || typeof raw.notes === 'string')
	) {
		return bad(`${at}: "expect" must be the record as it was read (host, type, content, ttl, prio, notes)`);
	}
	return {
		host: raw.host,
		type: raw.type,
		content: raw.content,
		ttl: raw.ttl,
		prio: raw.prio as number | null,
		notes: raw.notes as string | null
	};
}

/** `{ record, expect? }` of a PUT, or `{ expect? }` of a DELETE, as one change. */
export function parseChange(op: 'create' | 'edit' | 'delete', id: string | null, raw: unknown): RecordChange {
	const body = isObj(raw) ? raw : {};
	if (op === 'delete') {
		const expect = parseExpect(body.expect, 'This delete');
		return { op, id: id as string, ...(expect ? { expect } : {}) };
	}
	// A bare record is accepted as well as `{ record }`.
	const record = isObj(body.record) ? body.record : body;
	if (!isObj(record)) return bad('Send the record as a JSON object');
	if (op === 'create') return { op, record: record as never };
	const expect = parseExpect(body.expect, 'This edit');
	return { op, id: id as string, record: record as never, ...(expect ? { expect } : {}) };
}

/** The `changes` list of a preview or a batch. Shapes are checked here; the records themselves in the plan. */
export function parseChanges(raw: unknown): RecordChange[] {
	if (!isObj(raw) || !Array.isArray(raw.changes)) return bad('Send { "changes": [ … ] }');
	const list = raw.changes as unknown[];
	if (list.length === 0) return bad('There are no changes to apply');
	if (list.length > MAX_BATCH) {
		return bad(
			`A batch can hold at most ${MAX_BATCH} changes; this one has ${list.length}. Apply it in parts, or use the import for many new records`
		);
	}
	return list.map((item, i): RecordChange => {
		const at = `Change ${i + 1}`;
		if (!isObj(item)) return bad(`${at} is not an object`);
		if (item.op === 'create') {
			if (!isObj(item.record)) return bad(`${at} has no record`);
			return { op: 'create', record: item.record as never };
		}
		if (item.op !== 'edit' && item.op !== 'delete') return bad(`${at}: "op" must be create, edit or delete`);
		if (typeof item.id !== 'string' || !RECORD_ID.test(item.id)) return bad(`${at} has no record id`);
		const expect = parseExpect(item.expect, at);
		if (item.op === 'delete') return { op: 'delete', id: item.id, ...(expect ? { expect } : {}) };
		if (!isObj(item.record)) return bad(`${at} has no record`);
		return { op: 'edit', id: item.id, record: item.record as never, ...(expect ? { expect } : {}) };
	});
}

/** More than one delete at a time needs the domain name typed (docs/porkbun-plan.md §3.1 rule 3). */
export const needsTypedConfirm = (changes: readonly RecordChange[]): boolean =>
	changes.filter((c) => c.op === 'delete').length > 1;

// ── Planning ─────────────────────────────────────────────────────────────────────────────────────────────

/** Answer 400 for a record that is not valid: that is a mistake in the request, not a clash with the zone. */
function refuseInvalid(plan: readonly PlannedChange[]): void {
	for (const item of plan) {
		const invalid = item.problems.find((p) => p.code === 'INVALID');
		if (!invalid) continue;
		const body: InvalidRecord = {
			message:
				plan.length > 1
					? `Change ${item.index + 1} is not a valid record: ${invalid.message}`
					: invalid.message,
			code: 'INVALID_RECORD',
			fields: invalid.fields ?? [],
			index: item.index
		};
		throw new Refusal(400, body);
	}
}

function refuseProblems(plan: PlannedChange[]): void {
	const first = plan.find((p) => p.problems.length > 0);
	if (!first) return;
	const body: PlanRefusal = {
		message:
			plan.length > 1
				? `Nothing was changed. Change ${first.index + 1} can not be applied: ${first.problems[0]?.message}`
				: `Nothing was changed. ${first.problems[0]?.message}`,
		code: 'PLAN_REFUSED',
		items: plan
	};
	throw new Refusal(409, body);
}

async function planFresh(domain: string, changes: readonly RecordChange[]) {
	await porkbunStatus();
	requireWritable('dns');
	const zone = await freshZone(domain);
	const plan = planChanges(zone.data.records, changes, domain);
	refuseInvalid(plan);
	return { zone, plan };
}

const unique = (lists: readonly (readonly string[])[]): string[] => [...new Set(lists.flat())];

/**
 * The review step's data: the plan against the zone as it is now and, for every change Porkbun can judge on
 * its own, Porkbun's dry run. Sends nothing that changes anything.
 */
export async function previewChanges(domain: string, changes: readonly RecordChange[]): Promise<Preview> {
	const { zone, plan } = await planFresh(domain, changes);
	const blocked = plan.some((p) => p.problems.length > 0);
	const pb = porkbun();
	const items: PreviewItem[] = await Promise.all(
		plan.map(async (p): Promise<PreviewItem> => {
			const change = changes[p.index] as RecordChange;
			// With a problem anywhere the batch can not be applied, so Porkbun is not asked about the rest.
			if (blocked || p.needsEarlier) return { ...p, dryRun: null };
			if (change.op === 'create' && p.input) {
				return { ...p, dryRun: await pb.dns.dryRun.create(domain, p.input) };
			}
			if (change.op === 'delete') return { ...p, dryRun: await pb.dns.dryRun.delete(domain, change.id) };
			if (change.op === 'edit' && p.changed.length > 0) {
				return { ...p, dryRun: await pb.dns.dryRun.edit(domain, change.id, patchOf(p)) };
			}
			return { ...p, dryRun: null };
		})
	);
	return {
		items,
		wouldSucceed: !blocked && items.every((i) => i.dryRun === null || i.dryRun.wouldSucceed),
		warnings: unique(items.map((i) => i.dryRun?.warnings ?? [])),
		fetchedAt: zone.fetchedAt,
		confirm: needsTypedConfirm(changes)
	};
}

// ── Applying ─────────────────────────────────────────────────────────────────────────────────────────────

const ADOPTED =
	'A record with this name, type and value was already there, so nothing was created. Its TTL and notes were left as they are.';

function emptyCounts(): Record<BatchItemStatus, number> {
	return { applied: 0, unchanged: 0, adopted: 0, failed: 0, not_applied: 0 };
}

function summed(items: BatchItem[]): BatchResult {
	const counts = emptyCounts();
	for (const item of items) counts[item.status]++;
	return {
		ok: counts.failed === 0 && counts.not_applied === 0,
		items,
		counts,
		warnings: unique(items.map((i) => i.warnings))
	};
}

/** Send one planned change through `write()` and say how it went. */
async function send(
	domain: string,
	author: string,
	change: RecordChange,
	p: PlannedChange
): Promise<BatchItem> {
	const base = { index: p.index, op: p.op, name: p.name, type: p.type };
	if (change.op === 'create') {
		const input = p.input;
		if (!input) return { ...base, status: 'failed', warnings: [] };
		const res = await write<{ id: string }>({
			scope: 'dns',
			author,
			domain,
			action: 'dns.create',
			request: input,
			run: (pb) => pb.dns.create(domain, input)
		});
		if (res.ok) {
			return { ...base, status: 'applied', id: res.data.id, warnings: res.warnings, auditId: res.auditId };
		}
		const existing = res.error.details?.existingId;
		if (
			res.error.code === 'DUPLICATE_RECORD' &&
			(typeof existing === 'string' || typeof existing === 'number')
		) {
			return { ...base, status: 'adopted', id: String(existing), warnings: [ADOPTED], auditId: res.auditId };
		}
		return { ...base, status: 'failed', error: res.error, warnings: [], auditId: res.auditId };
	}
	if (change.op === 'edit') {
		if (p.changed.length === 0) return { ...base, status: 'unchanged', id: change.id, warnings: [] };
		const patch = patchOf(p);
		const res = await write({
			scope: 'dns',
			author,
			domain,
			action: 'dns.edit',
			request: { id: change.id, ...patch },
			before: p.before,
			run: (pb) => pb.dns.edit(domain, change.id, patch)
		});
		return res.ok
			? { ...base, status: 'applied', id: change.id, warnings: res.warnings, auditId: res.auditId }
			: { ...base, status: 'failed', id: change.id, error: res.error, warnings: [], auditId: res.auditId };
	}
	const res = await write({
		scope: 'dns',
		author,
		domain,
		action: 'dns.delete',
		request: { id: change.id },
		before: p.before,
		run: (pb) => pb.dns.delete(domain, change.id)
	});
	return res.ok
		? { ...base, status: 'applied', id: change.id, warnings: res.warnings, auditId: res.auditId }
		: { ...base, status: 'failed', id: change.id, error: res.error, warnings: [], auditId: res.auditId };
}

/**
 * Apply a reviewed list of changes, in order. Everything is checked against a fresh read of the zone first,
 * and a problem with any change refuses the whole batch before a single write. Once writes are going out, the
 * first one that fails stops the batch: the changes after it were reviewed on the assumption that it worked,
 * so they are reported as not applied rather than sent into a zone nobody reviewed.
 */
export async function applyChanges(
	domain: string,
	changes: readonly RecordChange[],
	opts: { author: string; confirm?: unknown }
): Promise<BatchResult> {
	if (needsTypedConfirm(changes)) {
		const typed = typeof opts.confirm === 'string' ? opts.confirm.trim().toLowerCase() : '';
		if (typed !== domain) {
			throw new Refusal(400, {
				message: `Deleting more than one record at a time needs the domain name typed to confirm: send "confirm": "${domain}"`,
				code: 'CONFIRM_REQUIRED'
			});
		}
	}
	const { plan } = await planFresh(domain, changes);
	refuseProblems(plan);

	const items: BatchItem[] = [];
	let stopped = false;
	for (const p of plan) {
		if (stopped) {
			items.push({
				index: p.index,
				op: p.op,
				name: p.name,
				type: p.type,
				status: 'not_applied',
				warnings: []
			});
			continue;
		}
		const item = await send(domain, opts.author, changes[p.index] as RecordChange, p);
		items.push(item);
		if (item.status === 'failed') stopped = true;
	}
	return summed(items);
}

/** The outcome of a batch of one, in the shape every single write of the Domains area answers with. */
export function asWriteResult(result: BatchResult): WriteResult<{ id: string; adopted?: boolean }> {
	const item = result.items[0];
	if (!item || item.status === 'failed' || item.status === 'not_applied') {
		return {
			ok: false,
			error: item?.error ?? { code: 'UNKNOWN', message: 'The change was not applied', retryable: false },
			...(item?.auditId !== undefined ? { auditId: item.auditId } : {})
		};
	}
	return {
		ok: true,
		data: { id: item.id ?? '', ...(item.status === 'adopted' ? { adopted: true } : {}) },
		warnings: result.warnings,
		// 0 where nothing was sent, because the record already was as asked.
		auditId: item.auditId ?? 0
	};
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────────────────

export type ImportInput = { dryRun: boolean } & (
	{ kind: 'text'; text: string } | { kind: 'records'; records: unknown[] } | { kind: 'scan' }
);

export function parseImportBody(raw: unknown): ImportInput {
	if (!isObj(raw)) return bad('Send { "text": "…" }, { "records": [ … ] } or { "scan": true }');
	const dryRun = raw.dryRun === true;
	if (raw.scan === true) {
		if (!dryRun) {
			return bad('A scan only looks. Review what it found, then send those records to import them');
		}
		return { dryRun, kind: 'scan' };
	}
	if (typeof raw.text === 'string') {
		if (raw.text.trim() === '') return bad('There is nothing to import: the text is empty');
		return { dryRun, kind: 'text', text: raw.text };
	}
	if (Array.isArray(raw.records)) return { dryRun, kind: 'records', records: raw.records };
	return bad('Send { "text": "…" }, { "records": [ … ] } or { "scan": true }');
}

type Source = Omit<ParsedSource, 'source'> & { source: ImportReview['source'] };

async function importSource(domain: string, input: ImportInput): Promise<Source> {
	if (input.kind === 'text') return parseImportText(input.text, domain);
	if (input.kind === 'records') return { ...parseJsonRecords(input.records, domain), source: 'records' };
	const found = await porkbun().dns.scan(domain);
	const candidates = found.map((r, i): ImportCandidate => {
		const c: ImportCandidate = {
			line: i + 1,
			host: normaliseHost(r.host, domain),
			type: r.type,
			content: r.content
		};
		if (r.ttl !== undefined) c.ttl = r.ttl;
		if (r.prio !== undefined) c.prio = r.prio;
		return c;
	});
	return { source: 'scan', candidates, unreadable: [] };
}

/**
 * Import records from a zone file, a JSON list or a scan. With `dryRun` this is the review: every record is
 * sorted into new, already there, in conflict, left out or invalid against a fresh read of the zone, and
 * Porkbun rehearses the import of the new ones. Without it the new ones are created: all but NS records in
 * one import call (Porkbun takes a restore point first), NS records below the apex one by one.
 */
export async function importRecords(
	domain: string,
	input: ImportInput,
	author: string
): Promise<ImportReview> {
	await porkbunStatus();
	requireWritable('dns');
	const parsed = await importSource(domain, input);
	if (parsed.candidates.length > MAX_IMPORT_SOURCE) {
		throw new Refusal(400, {
			message: `The source has ${parsed.candidates.length} records; at most ${MAX_IMPORT_SOURCE} can be read at once`,
			code: 'TOO_MANY_RECORDS'
		});
	}
	const zone = await freshZone(domain);
	const entries = classifyImport(zone.data.records, parsed.candidates, domain);
	const { bulk, delegations } = sendable(entries);
	if (bulk.length > IMPORT_LIMIT) {
		throw new Refusal(400, {
			message: `${bulk.length} records would be created, and Porkbun takes at most ${IMPORT_LIMIT} in one import. Split the source and import it in parts`,
			code: 'TOO_MANY_RECORDS'
		});
	}

	const review: ImportReview = {
		dryRun: input.dryRun,
		source: parsed.source,
		entries,
		counts: countVerdicts(entries),
		unreadable: parsed.unreadable,
		porkbun: null,
		delegations: [],
		warnings: [],
		ok: true
	};
	const pb = porkbun();
	const warnings: string[][] = [];
	const settle = (): ImportReview => {
		review.counts = countVerdicts(review.entries);
		review.warnings = unique(warnings);
		return review;
	};

	if (input.dryRun) {
		if (bulk.length > 0) {
			try {
				const {
					warnings: w,
					requestId: _requestId,
					...result
				} = await pb.dns.import(domain, bulk, {
					dryRun: true
				});
				review.porkbun = result;
				warnings.push(w);
				if (result.failed > 0) review.ok = false;
			} catch (err) {
				if (!(err instanceof PorkbunError) || err.retryable) throw err;
				review.error = toApiError(err) as ApiError;
				review.ok = false;
			}
		}
		// Each delegation is rehearsed as the create it will be; one Porkbun would refuse is shown as a conflict.
		const news = review.entries.filter((e) => e.verdict === 'new' && e.type === 'NS');
		const runs = await Promise.all(delegations.map((d) => pb.dns.dryRun.create(domain, d)));
		runs.forEach((run, i) => {
			warnings.push(run.warnings);
			const entry = news[i];
			if (run.wouldSucceed || !entry) return;
			entry.verdict = 'conflict';
			entry.reason = run.error?.message ?? 'Porkbun would refuse this record';
			review.ok = false;
		});
		return settle();
	}

	if (bulk.length > 0) {
		const res = await write<ImportResult>({
			scope: 'dns',
			author,
			domain,
			action: 'dns.import',
			request: { source: parsed.source, records: bulk },
			run: (client) => client.dns.import(domain, bulk)
		});
		if (res.ok) {
			review.porkbun = res.data;
			warnings.push(res.warnings);
			if (res.data.failed > 0) review.ok = false;
		} else {
			review.error = res.error;
			review.ok = false;
		}
	}
	let index = 0;
	for (const d of delegations) {
		const base = {
			index: index++,
			op: 'create' as const,
			name: d.host === '' ? domain : `${d.host}.${domain}`,
			type: d.type
		};
		// When the import call itself failed, nothing after it is sent.
		if (review.error) {
			review.delegations.push({ ...base, status: 'not_applied', warnings: [] });
			continue;
		}
		const res = await write<{ id: string }>({
			scope: 'dns',
			author,
			domain,
			action: 'dns.create',
			request: d,
			run: (client) => client.dns.create(domain, d)
		});
		if (res.ok) {
			warnings.push(res.warnings);
			review.delegations.push({
				...base,
				status: 'applied',
				id: res.data.id,
				warnings: res.warnings,
				auditId: res.auditId
			});
		} else if (res.error.code === 'DUPLICATE_RECORD') {
			review.delegations.push({ ...base, status: 'adopted', warnings: [ADOPTED], auditId: res.auditId });
		} else {
			review.delegations.push({
				...base,
				status: 'failed',
				error: res.error,
				warnings: [],
				auditId: res.auditId
			});
			review.ok = false;
		}
	}
	return settle();
}
