import { invalidate } from '$app/navigation';
import { formatElapsed, formatPercent } from '$lib/format';

export type Status = 'up' | 'down' | 'unknown';

export const RANGE_LABEL: Record<string, string> = {
	'1h': 'last hour',
	'24h': 'last 24 hours',
	'7d': 'last 7 days',
	'30d': 'last 30 days'
};

/** "per 5 minutes": what one bucket of a traffic chart counts. */
export function stepLabel(stepMs: number): string {
	const min = Math.round(stepMs / 60_000);
	if (min === 1) return 'per minute';
	if (min < 60) return `per ${min} minutes`;
	const h = Math.round(min / 60);
	return h === 1 ? 'per hour' : `per ${h} hours`;
}

export const statusKind = (s: Status) => (s === 'up' ? 'success' : s === 'down' ? 'error' : 'neutral');

/** "Up for 4d 2h 9m", "Down for 3m", "No probe yet". */
export function statusLine(status: Status, since: number | null, now: number): string {
	if (status === 'unknown')
		return since === null ? 'Not probed yet' : `Unknown for ${formatElapsed(now - since)}`;
	const word = status === 'up' ? 'Up' : 'Down';
	return since === null ? word : `${word} for ${formatElapsed(now - since)}`;
}

/** 5xx share of requests, or null when either is unknown. */
export function errorRate(requests: number | null, errors: number | null): number | null {
	if (requests === null || errors === null) return null;
	if (requests === 0) return 0;
	return errors / requests;
}

export const pct = (v: number | null) => (v === null ? '—' : formatPercent(v));

/** Re-runs the page's load every 30 s while the tab is visible, so status and charts stay current. */
export function autoRefresh(ms = 30_000): () => void {
	const id = setInterval(() => {
		if (document.visibilityState === 'visible') void invalidate('app:stats');
	}, ms);
	return () => clearInterval(id);
}
