import type { SnapshotRecord } from '$lib/api/porkbun';

/** Words for Porkbun's restore point reasons. Unknown reasons are shown as Porkbun wrote them. */
export function reasonLabel(reason: string): string {
	const restore = /^before-restore-(\d+)$/.exec(reason);
	if (restore) return `Before restoring point ${restore[1]}`;
	const known: Record<string, string> = {
		'before-create': 'Before a record was added',
		'before-edit': 'Before a record was changed',
		'before-delete': 'Before a record was deleted',
		'before-import': 'Before an import',
		manual: 'Taken by hand'
	};
	return known[reason] ?? reason;
}

/** One line for a record in a diff or a review: "MX example.com". */
export function recordTitle(r: Pick<SnapshotRecord, 'type' | 'name'>): string {
	return `${r.type} ${r.name}`;
}

/** The value as a zone file would show it: priority first where there is one. */
export function recordValue(r: Pick<SnapshotRecord, 'content' | 'prio' | 'ttl'>): string {
	return `${r.prio === null ? '' : `${r.prio} `}${r.content} · TTL ${r.ttl}`;
}
