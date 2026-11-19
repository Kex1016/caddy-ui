import type { ApiError, DryRun } from '$lib/api/porkbun';
import type { ReviewChange } from '$lib/porkbun/types';
import { dependents, type MarkMap } from './marks';
import { summarise } from './plan';
import type { BatchResult, PlannedChange, Preview, PreviewItem, RecordChange } from './types';

/**
 * The review of a batch, in the shape `ReviewDialog` shows: one line per change with before and after, and
 * under it whatever is worth knowing before it is sent.
 */

const NEEDS_EARLIER =
	'Porkbun can not rehearse this one on its own: it only works once an earlier change in this list has been made.';

function noteOf(item: PlannedChange | PreviewItem, change: RecordChange | undefined, marks: MarkMap): string {
	const lines: string[] = [];
	for (const p of item.problems) lines.push(`Can not be applied: ${p.message}.`);
	const rehearsal = 'dryRun' in item ? item.dryRun : null;
	if (rehearsal && !rehearsal.wouldSucceed && rehearsal.error) {
		lines.push(`Porkbun would refuse this: ${rehearsal.error.message}`);
	}
	if (item.op === 'edit' && item.changed.length === 0 && item.problems.length === 0) {
		lines.push('Already as asked. Nothing is sent for this one.');
	}
	if (item.needsEarlier && item.problems.length === 0) lines.push(NEEDS_EARLIER);
	// What depends on a record matters when the change can go ahead; a change that can not is not sent.
	if (change && change.op !== 'create' && item.problems.length === 0) {
		const uses = dependents(marks[change.id], change.op);
		if (uses) lines.push(uses);
	}
	lines.push(...item.advice);
	return lines.join(' ');
}

/** `changes` is the batch as it was sent, in the same order as `items`. */
export function reviewChanges(
	items: readonly (PlannedChange | PreviewItem)[],
	changes: readonly RecordChange[],
	marks: MarkMap = {}
): ReviewChange[] {
	return items.map((item) => {
		const note = noteOf(item, changes[item.index], marks);
		return {
			kind: item.op,
			title: `${item.type} ${item.name}`.trim() || `Change ${item.index + 1}`,
			...(item.before ? { before: summarise(item.before) } : {}),
			...(item.after ? { after: summarise(item.after) } : {}),
			...(note ? { note } : {})
		};
	});
}

/** How many changes of a plan can not be applied. */
export function problemCount(items: readonly PlannedChange[]): number {
	return items.filter((i) => i.problems.length > 0).length;
}

/** Why a plan can not be applied at all, or null. */
export function blockedReason(items: readonly PlannedChange[]): string | null {
	const n = problemCount(items);
	if (n === 0) return null;
	return n === 1
		? 'One change can not be applied as it is; the list says why. Take it out of the pending changes or correct it, then review again.'
		: `${n} changes can not be applied as they are; the list says why. Take them out of the pending changes or correct them, then review again.`;
}

/**
 * Porkbun's rehearsals of a batch as one result for the dialog. null when Porkbun was not asked about any
 * change (the plan has a problem, or no change could be rehearsed on its own).
 */
export function overallDryRun(preview: Preview): DryRun | null {
	const asked = preview.items.filter((i) => i.dryRun !== null);
	if (asked.length === 0) return null;
	const refused = asked.find((i) => i.dryRun && !i.dryRun.wouldSucceed);
	const error: ApiError | undefined = refused?.dryRun?.error;
	return {
		wouldSucceed: !refused,
		warnings: preview.warnings,
		...(error ? { error } : {})
	};
}

/** `3 changes applied`, `1 of 4 changes applied`: the headline of what a batch did. */
export function batchHeadline(result: BatchResult): string {
	const done = result.counts.applied + result.counts.unchanged + result.counts.adopted;
	const total = result.items.length;
	const noun = total === 1 ? 'change' : 'changes';
	return done === total ? `${total} ${noun} applied` : `${done} of ${total} ${noun} applied`;
}

const STATUS_TEXT: Record<BatchResult['items'][number]['status'], string> = {
	applied: 'Applied',
	unchanged: 'Already as asked',
	adopted: 'Already there',
	failed: 'Failed',
	not_applied: 'Not sent'
};

export const statusText = (status: BatchResult['items'][number]['status']): string => STATUS_TEXT[status];
