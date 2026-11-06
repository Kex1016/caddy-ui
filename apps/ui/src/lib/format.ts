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

/** "17:44": a clock time for chart ticks, where the zone is named once in the readout. */
export function formatClock(ts: number, timeZone: string): string {
	return new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZone
	}).format(ts);
}

/** "4 Nov": a day for chart ticks. */
export function formatDay(ts: number, timeZone: string): string {
	return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone })
		.format(ts)
		.replace(/Sept/, 'Sep');
}

/** "4 Nov, 17:44 CET": a point in a multi-day chart. */
export function formatDayTime(ts: number, timeZone: string): string {
	return `${formatDay(ts, timeZone)}, ${formatTime(ts, timeZone)}`;
}

const trim = (n: number, digits: number) => {
	const s = n.toFixed(digits);
	return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

/** "12.4 MB": decimal units, as Caddy and browsers report sizes. */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n)) return '—';
	const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
	let i = 0;
	let v = Math.abs(n);
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${n < 0 ? '-' : ''}${i === 0 ? Math.round(v) : trim(v, v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

/** "84 ms", "1.24 s": a latency. */
export function formatMs(ms: number): string {
	if (!Number.isFinite(ms)) return '—';
	if (Math.abs(ms) < 1) return `${trim(ms, 2)} ms`;
	if (Math.abs(ms) < 1000) return `${trim(ms, ms < 10 ? 1 : 0)} ms`;
	return `${trim(ms / 1000, 2)} s`;
}

/** "99.95%": a ratio 0–1. Near 0% and 100% it keeps two decimals, so 0.99996 never reads as 100%. */
export function formatPercent(ratio: number): string {
	if (!Number.isFinite(ratio)) return '—';
	const pct = ratio * 100;
	if (pct <= 0 || pct >= 100) return `${trim(pct, 2)}%`;
	if (pct >= 99) return `${trim(Math.min(Math.floor(pct * 100) / 100, 99.99), 2)}%`;
	if (pct < 1) return pct < 0.01 ? '<0.01%' : `${trim(pct, 2)}%`;
	return `${trim(pct, 1)}%`;
}

/** "1.2k", "3.4M": a count where space is tight (axis ticks); tiles and tables use formatNumber. */
export function formatCompact(n: number): string {
	if (!Number.isFinite(n)) return '—';
	const a = Math.abs(n);
	if (a < 1000) return trim(n, a < 10 && !Number.isInteger(n) ? 1 : 0);
	if (a < 1e6) return `${trim(n / 1e3, a < 1e4 ? 1 : 0)}k`;
	if (a < 1e9) return `${trim(n / 1e6, a < 1e7 ? 1 : 0)}M`;
	return `${trim(n / 1e9, 1)}G`;
}
