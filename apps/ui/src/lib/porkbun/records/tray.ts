import { isKnownRecordType, type DnsRecord, type DnsRecordInput } from '$lib/api/porkbun';
import type { BatchResult, RecordChange, RecordSnapshot } from './types';
import { sameSnapshot, snapshotOf } from './validate';

/**
 * The pending-changes tray: changes a person has decided on but not sent. Nothing here touches Porkbun; the
 * tray is reviewed and applied as one batch. It lives in the page and, so a reload does not lose it, in the
 * browser's session storage under the domain's name.
 */

export type Pending = {
	/** `id:<record id>` for a change to a live record, `new:<n>` for a record to add. */
	key: string;
	change: RecordChange;
};

export const TRAY_LIMIT = 100;

export const trayStorageKey = (domain: string) => `caddy-ui:dns-tray:${domain}`;

const keyOfRecord = (id: string) => `id:${id}`;

function nextNewKey(tray: readonly Pending[]): string {
	let max = 0;
	for (const p of tray) {
		const m = /^new:(\d+)$/.exec(p.key);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `new:${max + 1}`;
}

/** The pending change to a live record, if there is one. */
export function pendingFor(tray: readonly Pending[], id: string): Pending | undefined {
	return tray.find((p) => p.key === keyOfRecord(id));
}

/** A live record as the input an edit starts from. Only for a type this build writes. */
export function inputOf(live: DnsRecord): DnsRecordInput {
	const record: DnsRecordInput = {
		host: live.host,
		type: live.type as DnsRecordInput['type'],
		content: live.content,
		ttl: live.ttl,
		notes: live.notes ?? ''
	};
	if (live.prio !== null) record.prio = live.prio;
	return record;
}

/** Add a record. With `replaceKey` the record of a pending add is replaced instead. */
export function stageCreate(
	tray: readonly Pending[],
	record: DnsRecordInput,
	replaceKey?: string
): Pending[] {
	const change: RecordChange = { op: 'create', record };
	if (replaceKey && tray.some((p) => p.key === replaceKey)) {
		return tray.map((p) => (p.key === replaceKey ? { key: p.key, change } : p));
	}
	return [...tray, { key: nextNewKey(tray), change }];
}

/** The record an edit leaves behind, to compare with the live one. */
function afterEdit(live: RecordSnapshot, record: DnsRecordInput): RecordSnapshot {
	return {
		host: record.host,
		type: record.type,
		content: record.content,
		ttl: record.ttl ?? live.ttl,
		prio: record.prio ?? live.prio,
		notes: record.notes ?? live.notes
	};
}

/**
 * Change a live record. An edit that leaves the record as it is takes the record out of the tray again, so
 * the tray never holds a change that changes nothing.
 */
export function stageEdit(tray: readonly Pending[], live: DnsRecord, record: DnsRecordInput): Pending[] {
	const key = keyOfRecord(live.id);
	const rest = tray.filter((p) => p.key !== key);
	const before = snapshotOf(live);
	if (sameSnapshot(before, afterEdit(before, record))) return rest;
	const change: RecordChange = { op: 'edit', id: live.id, record, expect: before };
	const at = tray.findIndex((p) => p.key === key);
	if (at < 0) return [...rest, { key, change }];
	return tray.map((p) => (p.key === key ? { key, change } : p));
}

/** Delete live records. Replaces a pending edit of the same record. */
export function stageDelete(tray: readonly Pending[], records: readonly DnsRecord[]): Pending[] {
	let out = [...tray];
	for (const live of records) {
		const key = keyOfRecord(live.id);
		const change: RecordChange = { op: 'delete', id: live.id, expect: snapshotOf(live) };
		out = out.some((p) => p.key === key)
			? out.map((p) => (p.key === key ? { key, change } : p))
			: [...out, { key, change }];
	}
	return out;
}

export function unstage(tray: readonly Pending[], key: string): Pending[] {
	return tray.filter((p) => p.key !== key);
}

const OP_RANK = { delete: 0, edit: 1, create: 2 } as const;

/**
 * The order a batch is sent in: deletes, then edits, then adds, each in the order they were made. A record
 * that replaces another (a CNAME for the A record at the same name) then finds its place free, whichever of
 * the two was decided first.
 */
export function inSendOrder(tray: readonly Pending[]): Pending[] {
	return tray
		.map((p, i) => ({ p, i }))
		.sort((a, b) => OP_RANK[a.p.change.op] - OP_RANK[b.p.change.op] || a.i - b.i)
		.map((x) => x.p);
}

/**
 * What is left after a batch: changes that went through leave the tray, a change that failed or was not sent
 * stays for another try. `sent` is the tray in the order it was sent.
 */
export function afterBatch(
	tray: readonly Pending[],
	sent: readonly Pending[],
	result: BatchResult
): Pending[] {
	const done = new Set<string>();
	for (const item of result.items) {
		const key = sent[item.index]?.key;
		if (key && (item.status === 'applied' || item.status === 'unchanged' || item.status === 'adopted')) {
			done.add(key);
		}
	}
	return tray.filter((p) => !done.has(p.key));
}

// ── Session storage ─────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const optional = (v: unknown, type: 'number' | 'string') => v === undefined || typeof v === type;

function asInput(v: unknown): DnsRecordInput | null {
	if (!isObj(v) || typeof v.host !== 'string' || typeof v.content !== 'string') return null;
	if (typeof v.type !== 'string' || !isKnownRecordType(v.type)) return null;
	if (!optional(v.ttl, 'number') || !optional(v.prio, 'number') || !optional(v.notes, 'string')) return null;
	const record: DnsRecordInput = { host: v.host, type: v.type, content: v.content };
	if (typeof v.ttl === 'number') record.ttl = v.ttl;
	if (typeof v.prio === 'number') record.prio = v.prio;
	if (typeof v.notes === 'string') record.notes = v.notes;
	return record;
}

function asSnapshot(v: unknown): RecordSnapshot | undefined {
	if (!isObj(v) || typeof v.host !== 'string' || typeof v.type !== 'string') return undefined;
	if (typeof v.content !== 'string' || typeof v.ttl !== 'number') return undefined;
	return {
		host: v.host,
		type: v.type,
		content: v.content,
		ttl: v.ttl,
		prio: typeof v.prio === 'number' ? v.prio : null,
		notes: typeof v.notes === 'string' ? v.notes : null
	};
}

export function serialiseTray(tray: readonly Pending[]): string {
	return JSON.stringify({ v: 1, items: tray });
}

/** A stored tray, read back. Anything that is not exactly a tray is dropped, entry by entry. */
export function restoreTray(text: string | null | undefined): Pending[] {
	if (!text) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!isObj(parsed) || parsed.v !== 1 || !Array.isArray(parsed.items)) return [];
	const out: Pending[] = [];
	const seen = new Set<string>();
	for (const entry of parsed.items.slice(0, TRAY_LIMIT)) {
		if (!isObj(entry) || typeof entry.key !== 'string' || !isObj(entry.change) || seen.has(entry.key))
			continue;
		const c = entry.change;
		let change: RecordChange | null = null;
		if (c.op === 'create' && /^new:\d+$/.test(entry.key)) {
			const record = asInput(c.record);
			if (record) change = { op: 'create', record };
		} else if ((c.op === 'edit' || c.op === 'delete') && typeof c.id === 'string' && /^\d+$/.test(c.id)) {
			if (entry.key !== keyOfRecord(c.id)) continue;
			const expect = asSnapshot(c.expect);
			if (c.op === 'delete') change = { op: 'delete', id: c.id, ...(expect ? { expect } : {}) };
			else {
				const record = asInput(c.record);
				if (record) change = { op: 'edit', id: c.id, record, ...(expect ? { expect } : {}) };
			}
		}
		if (!change) continue;
		seen.add(entry.key);
		out.push({ key: entry.key, change });
	}
	return out;
}
