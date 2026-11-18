import { isKnownRecordType, type DnsRecord, type DnsRecordInput, type ImportRecord } from '$lib/api/porkbun';
import { fqdn } from './names';
import { conflictsWith } from './plan';
import type { ImportCandidate, ImportEntry, ImportVerdict, RecordSnapshot } from './types';
import { USUAL_MIN_TTL, snapshotOf, validateRecord } from './validate';

/**
 * Decides, for every record read from a zone file, a JSON list or a scan, what an import would do with it:
 * create it, skip it because it is there already, or leave it out and say why. Pure and client-safe; the
 * import route runs it against a fresh read of the zone before anything is sent.
 */

/** Porkbun takes at most this many records in one import call. */
export const IMPORT_LIMIT = 500;

export function classifyImport(
	zone: readonly DnsRecord[],
	candidates: readonly ImportCandidate[],
	domain: string
): ImportEntry[] {
	const live: RecordSnapshot[] = zone.map(snapshotOf);
	const sim: RecordSnapshot[] = [...live];
	return candidates.map((c): ImportEntry => {
		const leaveOut = (verdict: ImportVerdict, reason: string): ImportEntry => ({ ...c, verdict, reason });
		if (c.type === 'SOA') return leaveOut('ignored', "The SOA record is Porkbun's own and is not imported");
		if (c.type === 'NS' && c.host === '') {
			return leaveOut(
				'ignored',
				"The domain's own nameservers are set at the registry, on the Registry tab, not by a record"
			);
		}
		if (!isKnownRecordType(c.type)) {
			return leaveOut('ignored', `${c.type} is not a record type Porkbun's DNS offers`);
		}
		const checked = validateRecord(
			{ host: c.host, type: c.type, content: c.content, ttl: c.ttl, prio: c.prio },
			domain
		);
		if (!checked.ok) return leaveOut('invalid', checked.errors[0]?.message ?? 'Not a valid record');

		const r = checked.record;
		const entry: ImportEntry = {
			line: c.line,
			host: r.host,
			type: r.type,
			content: r.content,
			verdict: 'new'
		};
		if (r.ttl !== undefined) entry.ttl = r.ttl;
		if (r.prio !== undefined) entry.prio = r.prio;
		if (c.notes !== undefined) entry.notes = c.notes;

		const snap: RecordSnapshot = {
			host: r.host,
			type: r.type,
			content: r.content,
			ttl: r.ttl ?? USUAL_MIN_TTL,
			prio: r.prio ?? null,
			notes: null
		};
		const [problem] = conflictsWith(sim, snap, fqdn(r.host, domain));
		if (problem) {
			if (problem.code === 'DUPLICATE') {
				const inZone = problem.records?.some((twin) => live.includes(twin)) ?? false;
				return {
					...entry,
					verdict: 'existing',
					reason: inZone ? 'Already in the zone' : 'Listed more than once; the first one counts'
				};
			}
			return { ...entry, verdict: 'conflict', reason: problem.message };
		}
		sim.push(snap);
		return entry;
	});
}

export function countVerdicts(entries: readonly ImportEntry[]): Record<ImportVerdict, number> {
	const counts: Record<ImportVerdict, number> = { new: 0, existing: 0, conflict: 0, ignored: 0, invalid: 0 };
	for (const e of entries) counts[e.verdict]++;
	return counts;
}

/**
 * What to send for the entries that will be created. Porkbun's import call skips every NS record, so a
 * delegation of a subdomain goes out as an ordinary create instead.
 */
export function sendable(entries: readonly ImportEntry[]): {
	bulk: ImportRecord[];
	delegations: DnsRecordInput[];
} {
	const bulk: ImportRecord[] = [];
	const delegations: DnsRecordInput[] = [];
	for (const e of entries) {
		if (e.verdict !== 'new' || !isKnownRecordType(e.type)) continue;
		if (e.type === 'NS') {
			delegations.push({
				host: e.host,
				type: 'NS',
				content: e.content,
				...(e.ttl !== undefined ? { ttl: e.ttl } : {})
			});
			continue;
		}
		const record: ImportRecord = { host: e.host, type: e.type, content: e.content };
		if (e.ttl !== undefined) record.ttl = e.ttl;
		if (e.prio !== undefined) record.prio = e.prio;
		bulk.push(record);
	}
	return { bulk, delegations };
}
