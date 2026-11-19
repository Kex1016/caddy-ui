import { isKnownRecordType, type DnsRecord, type DnsRecordInput } from '$lib/api/porkbun';
import { RECORD_KINDS } from './kinds';
import { fqdn } from './names';
import type { FieldName, PlannedChange, Problem, RecordChange, RecordSnapshot } from './types';
import { USUAL_MIN_TTL, sameSnapshot, snapshotOf, validateRecord } from './validate';

/**
 * Works out what a list of changes does to a zone, in order, without sending anything. Pure and client-safe:
 * the page uses it to say "that name already has a CNAME" the moment a change is staged, and the routes use
 * it on a fresh read of the zone before a single write goes out.
 *
 * Each change is judged against the zone as it will be when its turn comes, so "delete the A record, then
 * add a CNAME at the same name" is fine in that order and refused in the other.
 */

type Row = { id: string | null; snap: RecordSnapshot; from: number | null };

const isSpf = (r: RecordSnapshot) => r.type === 'TXT' && /^"?v=spf1(\s|$|")/i.test(r.content.trim());

/** What stands in the way of `next` among `others`: the same checks Porkbun makes, plus one it makes at the apex. */
export function conflictsWith(
	others: readonly RecordSnapshot[],
	next: RecordSnapshot,
	name: string
): Problem[] {
	const twin = others.find((r) => r.host === next.host && r.type === next.type && r.content === next.content);
	if (twin) {
		return [
			{
				code: 'DUPLICATE',
				message: `There is already ${article(next.type)} ${next.type} record at ${name} with this value`,
				records: [twin]
			}
		];
	}
	const atName = others.filter((r) => r.host === next.host);
	if (next.type === 'CNAME' && atName.length > 0) {
		return [
			{
				code: 'CNAME_CONFLICT',
				message: `A CNAME must be the only record at its name, and ${name} has ${count(atName.length, 'other record')}. Delete ${atName.length === 1 ? 'it' : 'them'} first, or use another name`,
				records: atName
			}
		];
	}
	const cnames = atName.filter((r) => r.type === 'CNAME');
	if (next.type !== 'CNAME' && cnames.length > 0) {
		return [
			{
				code: 'CNAME_CONFLICT',
				message: `${name} has a CNAME record, and a CNAME must be the only record at its name. Delete the CNAME first, or use another name`,
				records: cnames
			}
		];
	}
	if (next.host === '' && isSpf(next)) {
		const spf = atName.filter(isSpf);
		if (spf.length > 0) {
			return [
				{
					code: 'SPF_CONFLICT',
					message:
						'The bare domain already has an SPF record. Two of them make SPF fail for all mail, so put both policies in one record',
					records: spf
				}
			];
		}
	}
	return [];
}

const article = (type: string) => (/^[AEFHIMNSX]/.test(type) ? 'an' : 'a');
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The record a create makes, as far as it can be known before Porkbun stores it. */
function created(record: DnsRecordInput): RecordSnapshot {
	return {
		host: record.host,
		type: record.type,
		content: record.content,
		ttl: record.ttl ?? USUAL_MIN_TTL,
		prio: record.prio ?? null,
		notes: record.notes ? record.notes : null
	};
}

/** The record an edit leaves: what was given replaces, what was left out stays. */
function edited(before: RecordSnapshot, record: DnsRecordInput): RecordSnapshot {
	const usesPrio = isKnownRecordType(record.type) && RECORD_KINDS[record.type].usesPrio;
	return {
		host: record.host,
		type: record.type,
		content: record.content,
		ttl: record.ttl ?? before.ttl,
		prio: usesPrio ? (record.prio ?? before.prio ?? 0) : before.prio,
		notes: record.notes === undefined ? before.notes : record.notes === '' ? null : record.notes
	};
}

function changedFields(before: RecordSnapshot, after: RecordSnapshot): FieldName[] {
	const out: FieldName[] = [];
	if (before.host !== after.host) out.push('host');
	if (before.type !== after.type) out.push('type');
	if (before.content !== after.content) out.push('content');
	if (before.ttl !== after.ttl) out.push('ttl');
	if ((before.prio ?? 0) !== (after.prio ?? 0)) out.push('prio');
	if ((before.notes ?? '') !== (after.notes ?? '')) out.push('notes');
	return out;
}

/** The fields of an edit to send to Porkbun: only what changes. '' clears the notes. */
export function patchOf(item: Pick<PlannedChange, 'after' | 'changed'>): Partial<DnsRecordInput> {
	const after = item.after;
	const patch: Partial<DnsRecordInput> = {};
	if (!after) return patch;
	for (const field of item.changed) {
		if (field === 'host') patch.host = after.host;
		else if (field === 'content') patch.content = after.content;
		else if (field === 'ttl') patch.ttl = after.ttl;
		else if (field === 'prio') patch.prio = after.prio ?? 0;
		else if (field === 'notes') patch.notes = after.notes ?? '';
	}
	return patch;
}

export function planChanges(
	zone: readonly DnsRecord[],
	changes: readonly RecordChange[],
	domain: string
): PlannedChange[] {
	const original: Row[] = zone.map((r) => ({ id: r.id, snap: snapshotOf(r), from: null }));
	const sim: Row[] = original.map((r) => ({ ...r }));
	/** Record id to the change that already touched it. */
	const touched = new Map<string, number>();
	const out: PlannedChange[] = [];

	const judge = (after: RecordSnapshot, selfId: string | null, name: string) => {
		const others = (rows: Row[]) => rows.filter((r) => selfId === null || r.id !== selfId).map((r) => r.snap);
		const then = conflictsWith(others(sim), after, name);
		const now = conflictsWith(others(original), after, name);
		return { problems: then, needsEarlier: then.length === 0 && now.length > 0 };
	};

	changes.forEach((change, index) => {
		const item: PlannedChange = {
			index,
			op: change.op,
			name: '',
			type: '',
			before: null,
			after: null,
			input: null,
			changed: [],
			problems: [],
			advice: [],
			needsEarlier: false
		};
		out.push(item);

		if (change.op === 'create') {
			const checked = validateRecord(change.record, domain);
			item.type = typeof change.record?.type === 'string' ? change.record.type : '';
			item.name = fqdn(typeof change.record?.host === 'string' ? change.record.host : '', domain);
			if (!checked.ok) {
				item.problems.push({
					code: 'INVALID',
					message: checked.errors[0]?.message ?? 'Not valid',
					fields: checked.errors
				});
				return;
			}
			item.type = checked.record.type;
			item.name = fqdn(checked.record.host, domain);
			item.input = checked.record;
			item.after = created(checked.record);
			item.advice = checked.advice;
			const verdict = judge(item.after, null, item.name);
			item.problems = verdict.problems.map((p) =>
				p.code === 'DUPLICATE' && !original.some((r) => r.snap === p.records?.[0])
					? { ...p, message: `${p.message}: it comes from an earlier change in the same batch` }
					: p
			);
			item.needsEarlier = verdict.needsEarlier;
			if (item.problems.length === 0) sim.push({ id: null, snap: item.after, from: index });
			return;
		}

		const live = original.find((r) => r.id === change.id);
		item.name = live ? fqdn(live.snap.host, domain) : '';
		item.type = live?.snap.type ?? '';
		item.before = live?.snap ?? null;
		const earlier = touched.get(change.id);
		if (earlier !== undefined) {
			item.problems.push({
				code: 'REPEATED',
				message: `This record is changed more than once in the same batch (also by change ${earlier + 1})`
			});
			return;
		}
		touched.set(change.id, index);
		if (!live) {
			item.problems.push({
				code: 'MISSING',
				message: 'This record is no longer in the zone. It may have been deleted somewhere else'
			});
			return;
		}
		if (change.expect && !sameSnapshot(change.expect, live.snap)) {
			item.problems.push({
				code: 'STALE',
				message: `This record was changed somewhere else after you opened it. It now reads: ${summarise(live.snap)}`,
				records: [live.snap]
			});
			return;
		}
		if (!isKnownRecordType(live.snap.type)) {
			item.problems.push({
				code: 'READ_ONLY_TYPE',
				message: `${live.snap.type} is a record type this version of Caddy UI can only show. Change it at porkbun.com`
			});
			return;
		}
		const at = sim.findIndex((r) => r.id === change.id);

		if (change.op === 'delete') {
			if (at >= 0) sim.splice(at, 1);
			return;
		}

		const checked = validateRecord(change.record, domain, { stored: live.snap });
		if (!checked.ok) {
			item.problems.push({
				code: 'INVALID',
				message: checked.errors[0]?.message ?? 'Not valid',
				fields: checked.errors
			});
			return;
		}
		if (checked.record.type !== live.snap.type) {
			item.problems.push({
				code: 'TYPE_CHANGE',
				message: `The type of a record can not be changed (${live.snap.type} to ${checked.record.type}). Delete it and add a new record instead`
			});
			return;
		}
		item.after = edited(live.snap, checked.record);
		item.changed = changedFields(live.snap, item.after);
		item.name = fqdn(item.after.host, domain);
		item.advice = checked.advice;
		// A record that is only re-timed or annotated is not checked against its neighbours: the zone may
		// hold old combinations this UI would not create, and they are not made worse by a new note.
		if (item.changed.some((f) => f === 'host' || f === 'content')) {
			const verdict = judge(item.after, change.id, item.name);
			item.problems = verdict.problems;
			item.needsEarlier = verdict.needsEarlier;
		}
		if (item.problems.length === 0 && at >= 0) sim[at] = { id: change.id, snap: item.after, from: index };
	});
	return out;
}

/** A record's data on one line, for before and after: `10 mail.example.com · TTL 600 · note: backup MX`. */
export function summarise(r: RecordSnapshot): string {
	const usesPrio = isKnownRecordType(r.type) && RECORD_KINDS[r.type].usesPrio;
	const value = usesPrio ? `${r.prio ?? 0} ${r.content}` : r.content;
	const parts = [value, `TTL ${r.ttl}`];
	if (r.notes) parts.push(`note: ${r.notes}`);
	return parts.join(' · ');
}
