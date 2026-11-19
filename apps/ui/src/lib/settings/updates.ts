import type { UpdateResult, UpdateTrigger, UpdatesView } from '$lib/api/updates';

/** Wording for the Updates section (docs/settings-and-perf-plan.md §3). Client-safe. */

export const RESULT_TAG: Record<
	UpdateResult,
	{ kind: 'success' | 'warning' | 'error' | 'acc'; text: string }
> = {
	'up-to-date': { kind: 'success', text: 'Up to date' },
	updated: { kind: 'acc', text: 'Updated' },
	'rolled-back': { kind: 'warning', text: 'Rolled back' },
	'needs-attention': { kind: 'error', text: 'Needs attention' },
	failed: { kind: 'error', text: 'Check failed' }
};

export const TRIGGER_TEXT: Record<UpdateTrigger, string> = {
	timer: 'on the timer',
	'check-now': 'by “Check now”',
	webhook: 'by a webhook',
	manual: 'by hand'
};

/** 3600 → "1h", 90 → "1m 30s". The updater reports seconds. */
export function intervalText(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
	const parts: string[] = [];
	let rest = Math.round(seconds);
	for (const [unit, size] of [
		['d', 86_400],
		['h', 3_600],
		['m', 60],
		['s', 1]
	] as const) {
		const n = Math.floor(rest / size);
		rest -= n * size;
		if (n > 0) parts.push(`${n}${unit}`);
	}
	return parts.join(' ');
}

/** One line on what the page cannot do right now, or null when the channel works. */
export function channelNotice(v: UpdatesView): { kind: 'warning' | 'neutral'; text: string } | null {
	if (v.state === 'no-channel') {
		return {
			kind: 'warning',
			text: `This UI cannot write to the updater's directory: ${v.problem ?? v.dir}. The interval is saved here but the updater will not see it, and “Check now” does nothing until both containers share that directory.`
		};
	}
	if (v.state === 'waiting') {
		return {
			kind: 'neutral',
			text: 'The updater has not reported yet. It writes its status within a few seconds of starting; if nothing changes, check that it is running and that both containers share the directory below.'
		};
	}
	if (v.state === 'stale') {
		return {
			kind: 'warning',
			text: 'The updater has not reported for a while, so what is shown may be old. Check that the caddy-ui-updater container is running.'
		};
	}
	return null;
}
