import { isKnownRecordType, type DnsRecord, type DnsRecordInput } from '$lib/api/porkbun';
import { RECORD_KINDS, type Parts, type RecordKind } from './kinds';
import { hasControlChar, hostProblem, normaliseHost } from './names';
import type { FieldError, RecordSnapshot } from './types';

/**
 * One set of rules for a record, used by the form (to say what is wrong next to the field) and by every
 * route (to refuse a bad record before anything is sent to Porkbun). Porkbun stays the final judge through
 * its dry run; this catches what is plainly wrong and puts the record in one canonical spelling.
 */

/** Porkbun raises a lower TTL to the account minimum, which is 600 s unless the account was given another. */
export const USUAL_MIN_TTL = 600;
const MAX_TTL = 2_147_483_647;
const MAX_NOTES = 1000;
const MAX_CONTENT = 8192;

export type Validated =
	{ ok: true; record: DnsRecordInput; advice: string[] } | { ok: false; errors: FieldError[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** A whole number given as a number or in digits (Porkbun's own JSON has "600"). undefined for null or absent. */
function numeric(v: unknown): number | undefined | 'bad' {
	if (v === undefined || v === null || v === '') return undefined;
	if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : 'bad';
	if (typeof v === 'string' && /^\d{1,10}$/.test(v.trim())) return Number(v.trim());
	return 'bad';
}

/** The form fields of a kind as a record's errors: the priority is its own field, the rest belong to content. */
function partErrors(kind: RecordKind, parts: Parts, host: string, domain: string): FieldError[] {
	return kind
		.check(parts, { host, domain })
		.map((e) =>
			e.part === 'prio' && kind.usesPrio
				? { field: 'prio' as const, part: e.part, message: e.message }
				: { field: 'content' as const, part: e.part, message: e.message }
		);
}

/** The fields every type has: the name, the TTL and the notes. */
function envelope(input: { host: string; ttl?: unknown; notes?: unknown }, domain: string) {
	const hostErrors: FieldError[] = [];
	const errors: FieldError[] = [];
	const host = normaliseHost(input.host, domain);
	const hostError = hostProblem(host, domain);
	if (hostError) hostErrors.push({ field: 'host', message: hostError });

	const ttl = numeric(input.ttl);
	if (ttl === 'bad' || (ttl !== undefined && ttl > MAX_TTL)) {
		errors.push({ field: 'ttl', message: 'The TTL is a whole number of seconds' });
	}

	let notes: string | undefined;
	if (input.notes !== undefined && input.notes !== null) {
		if (typeof input.notes !== 'string') errors.push({ field: 'notes', message: 'Notes must be text' });
		else if (hasControlChar(input.notes)) {
			errors.push({ field: 'notes', message: 'Notes must be on one line' });
		} else if (input.notes.length > MAX_NOTES) {
			errors.push({ field: 'notes', message: `Notes can be at most ${MAX_NOTES} characters` });
		} else notes = input.notes.trim();
	}
	// 0 means "the minimum" to Porkbun, the same as leaving the TTL out.
	return { host, ttl: typeof ttl === 'number' && ttl > 0 ? ttl : undefined, notes, hostErrors, errors };
}

function lowTtlAdvice(ttl: number | undefined): string[] {
	return ttl !== undefined && ttl < USUAL_MIN_TTL
		? [
				`Porkbun raises a TTL below its minimum, usually ${USUAL_MIN_TTL} seconds, so the stored value may be higher than ${ttl}.`
			]
		: [];
}

/**
 * Check a record given as form fields. This is what the form calls; `validateRecord` goes through it after
 * splitting the stored value.
 */
export function validateParts(
	input: { host: string; type: string; parts: Parts; ttl?: unknown; notes?: unknown },
	domain: string
): Validated {
	const env = envelope(input, domain);
	const errors: FieldError[] = [...env.hostErrors];

	if (!isKnownRecordType(input.type)) {
		errors.push({
			field: 'type',
			message: `${input.type || 'That'} is not a record type this page can write`
		});
		return { ok: false, errors };
	}
	const kind = RECORD_KINDS[input.type];
	errors.push(...partErrors(kind, input.parts, env.host, domain), ...env.errors);
	if (errors.length > 0) return { ok: false, errors };

	const joined = kind.join(input.parts);
	if (joined.content.length > MAX_CONTENT) {
		return {
			ok: false,
			errors: [{ field: 'content', message: `The value is longer than ${MAX_CONTENT} characters` }]
		};
	}
	const record: DnsRecordInput = { host: env.host, type: kind.type, content: joined.content };
	if (env.ttl !== undefined) record.ttl = env.ttl;
	if (kind.usesPrio) record.prio = joined.prio ?? 0;
	if (env.notes !== undefined) record.notes = env.notes;

	const advice = [
		...(kind.advise?.(input.parts, { host: env.host, domain }) ?? []),
		...lowTtlAdvice(record.ttl)
	];
	return { ok: true, record, advice };
}

/**
 * Check a record as JSON carries it (`{ host, type, content, ttl?, prio?, notes? }`) and return it in its
 * canonical spelling. `name` is accepted for `host`, since Porkbun's own JSON calls it that.
 */
export function validateRecord(
	raw: unknown,
	domain: string,
	opts: { stored?: RecordSnapshot } = {}
): Validated {
	if (!isObj(raw)) {
		return { ok: false, errors: [{ field: 'content', message: 'A record must be a JSON object' }] };
	}
	const hostRaw = raw.host ?? raw.name ?? '';
	if (typeof hostRaw !== 'string') {
		return { ok: false, errors: [{ field: 'host', message: 'The name must be text' }] };
	}
	const type = typeof raw.type === 'string' ? raw.type.trim().toUpperCase() : '';
	if (!isKnownRecordType(type)) {
		return {
			ok: false,
			errors: [{ field: 'type', message: `${type || 'That'} is not a record type this page can write` }]
		};
	}
	if (typeof raw.content !== 'string') {
		return { ok: false, errors: [{ field: 'content', message: 'The value must be text' }] };
	}
	const kind = RECORD_KINDS[type];
	const prio = numeric(raw.prio);
	if (kind.usesPrio && (prio === 'bad' || (prio !== undefined && prio > 65535))) {
		return {
			ok: false,
			errors: [{ field: 'prio', message: 'Priority must be a whole number from 0 to 65535' }]
		};
	}
	// A value kept exactly as Porkbun stores it is not judged again: the zone may hold a spelling this page
	// would not write, and changing such a record's TTL, notes or name must still be possible.
	const stored = opts.stored;
	const prioNow = typeof prio === 'number' ? prio : (stored?.prio ?? 0);
	if (stored && stored.type === type && stored.content === raw.content && prioNow === (stored.prio ?? 0)) {
		const env = envelope({ host: hostRaw, ttl: raw.ttl, notes: raw.notes }, domain);
		const errors = [...env.hostErrors, ...env.errors];
		if (errors.length > 0) return { ok: false, errors };
		const record: DnsRecordInput = { host: env.host, type, content: stored.content };
		if (env.ttl !== undefined) record.ttl = env.ttl;
		if (kind.usesPrio) record.prio = stored.prio ?? 0;
		if (env.notes !== undefined) record.notes = env.notes;
		return { ok: true, record, advice: lowTtlAdvice(record.ttl) };
	}
	const parts = kind.split(raw.content, typeof prio === 'number' ? prio : null);
	if (parts === null) {
		return {
			ok: false,
			errors: [
				{
					field: 'content',
					message: `This is not the form of ${article(type)} ${type} value. It is written as: ${formatOf(kind)}`
				}
			]
		};
	}
	return validateParts({ host: hostRaw, type, parts, ttl: raw.ttl, notes: raw.notes }, domain);
}

const article = (type: string) => (/^[AEFHIMNSX]/.test(type) ? 'an' : 'a');

/** "weight port target": the order of a kind's fields inside the stored value. */
export function formatOf(kind: RecordKind): string {
	return kind.fields
		.filter((f) => !(kind.usesPrio && f.key === 'prio'))
		.map((f) => f.label.toLowerCase())
		.join(', then ');
}

/** The data of a record as a snapshot: what `expect` carries and what plans compare. */
export function snapshotOf(record: Pick<DnsRecord, keyof RecordSnapshot>): RecordSnapshot {
	return {
		host: record.host,
		type: record.type,
		content: record.content,
		ttl: record.ttl,
		prio: record.prio,
		notes: record.notes
	};
}

/** Whether two snapshots describe the same stored record. A missing priority and 0 are the same thing. */
export function sameSnapshot(a: RecordSnapshot, b: RecordSnapshot): boolean {
	return (
		a.host === b.host &&
		a.type === b.type &&
		a.content === b.content &&
		a.ttl === b.ttl &&
		(a.prio ?? 0) === (b.prio ?? 0) &&
		(a.notes ?? '') === (b.notes ?? '')
	);
}
