/** Display formatting per Fishnet's content rules: "4 Nov 2026", "17:44 CET", "4d 2h 9m". */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Elapsed time as the two or three largest units: "4d 2h 9m", "2h 9m", "9m", "under a minute". */
export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < MINUTE) return 'under a minute';
	const d = Math.floor(ms / DAY);
	const h = Math.floor((ms % DAY) / HOUR);
	const m = Math.floor((ms % HOUR) / MINUTE);
	if (d > 0) return `${d}d ${h}h ${m}m`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

export function formatDate(ts: number, timeZone: string): string {
	return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone })
		.format(ts)
		.replace(/Sept/, 'Sep');
}

/** "17:44 CET": 24-hour time with the zone named, so a reader never has to guess. */
export function formatTime(ts: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZone,
		timeZoneName: 'short'
	}).formatToParts(ts);
	const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
	return `${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

export function formatDateTime(ts: number, timeZone: string): string {
	return `${formatDate(ts, timeZone)}, ${formatTime(ts, timeZone)}`;
}

export function formatNumber(n: number): string {
	return new Intl.NumberFormat('en-GB').format(n);
}
