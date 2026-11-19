import { isKnownRecordType, type DnsRecord } from '$lib/api/porkbun';
import { typeRank } from './kinds';
import { fqdn } from './names';
import type { Pending } from './tray';
import type { FieldName, RecordSnapshot } from './types';
import { snapshotOf } from './validate';
import { compareRecords, hostKey } from './zonefile';

/**
 * The records table: the live zone with the pending changes laid over it, so the table shows the zone as it
 * will be and says which rows are not real yet.
 */

export type RowState = 'live' | 'new' | 'edited' | 'deleted';

export type Row = {
	/** The record id, or the tray key of a record to add. */
	key: string;
	state: RowState;
	/** The live record, absent for a record to add. */
	live: DnsRecord | null;
	/** What the row shows: the record as it will be after the pending change. */
	shown: RecordSnapshot;
	name: string;
	/** False for a type this build only shows. */
	known: boolean;
	/** Edited rows: what differs from the live record. */
	changed: FieldName[];
};

export type Group = { host: string; name: string; rows: Row[] };

function changedFields(before: RecordSnapshot, after: RecordSnapshot): FieldName[] {
	const out: FieldName[] = [];
	if (before.host !== after.host) out.push('host');
	if (before.content !== after.content) out.push('content');
	if (before.ttl !== after.ttl) out.push('ttl');
	if ((before.prio ?? 0) !== (after.prio ?? 0)) out.push('prio');
	if ((before.notes ?? '') !== (after.notes ?? '')) out.push('notes');
	return out;
}

export function buildRows(records: readonly DnsRecord[], tray: readonly Pending[], domain: string): Row[] {
	const byId = new Map<string, Pending>();
	for (const p of tray) if (p.change.op !== 'create') byId.set(p.change.id, p);

	const rows: Row[] = records.map((live) => {
		const before = snapshotOf(live);
		const change = byId.get(live.id)?.change;
		const known = isKnownRecordType(live.type);
		if (change?.op === 'delete') {
			return { key: live.id, state: 'deleted', live, shown: before, name: live.name, known, changed: [] };
		}
		if (change?.op === 'edit') {
			const r = change.record;
			const shown: RecordSnapshot = {
				host: r.host,
				type: live.type,
				content: r.content,
				ttl: r.ttl ?? live.ttl,
				prio: r.prio ?? live.prio,
				notes: r.notes ?? live.notes
			};
			return {
				key: live.id,
				state: 'edited',
				live,
				shown,
				name: fqdn(shown.host, domain),
				known,
				changed: changedFields(before, shown)
			};
		}
		return { key: live.id, state: 'live', live, shown: before, name: live.name, known, changed: [] };
	});

	for (const p of tray) {
		if (p.change.op !== 'create') continue;
		const r = p.change.record;
		rows.push({
			key: p.key,
			state: 'new',
			live: null,
			shown: {
				host: r.host,
				type: r.type,
				content: r.content,
				ttl: r.ttl ?? 600,
				prio: r.prio ?? null,
				notes: r.notes ?? null
			},
			name: fqdn(r.host, domain),
			known: true,
			changed: []
		});
	}
	return rows.sort((a, b) => compareRecords(a.shown, b.shown));
}

export type Filter = {
	/** Words that must all appear in the name, type, value or notes. */
	query: string;
	/** A record type, or '' for all. */
	type: string;
	/** Only rows with a pending change. */
	pendingOnly?: boolean;
};

export function matches(row: Row, filter: Filter): boolean {
	if (filter.type && row.shown.type !== filter.type) return false;
	if (filter.pendingOnly && row.state === 'live') return false;
	const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const hay = [row.name, row.shown.type, row.shown.content, row.shown.notes ?? '', row.live?.content ?? '']
		.join('\n')
		.toLowerCase();
	return words.every((w) => hay.includes(w));
}

/** Rows under their name: the apex first, a subdomain under its parent. */
export function groupRows(rows: readonly Row[]): Group[] {
	const groups = new Map<string, Group>();
	for (const row of rows) {
		const host = row.shown.host;
		const group = groups.get(host) ?? { host, name: row.name, rows: [] };
		group.rows.push(row);
		groups.set(host, group);
	}
	return [...groups.values()].sort((a, b) => {
		const ka = hostKey(a.host);
		const kb = hostKey(b.host);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

/** The types present, most used types of the trade first, with how many rows each has. */
export function countTypes(rows: readonly Row[]): { type: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.shown.type, (counts.get(row.shown.type) ?? 0) + 1);
	return [...counts.entries()]
		.map(([type, count]) => ({ type, count }))
		.sort((a, b) => typeRank(a.type) - typeRank(b.type) || (a.type < b.type ? -1 : 1));
}

/** `10 min`, `1 h`, `2 d`: a TTL in the largest unit that divides it. */
export function ttlLabel(seconds: number): string {
	if (seconds > 0 && seconds % 86400 === 0) return `${seconds / 86400} d`;
	if (seconds > 0 && seconds % 3600 === 0) return `${seconds / 3600} h`;
	if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60} min`;
	return `${seconds} s`;
}
