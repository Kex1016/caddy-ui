import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatElapsed, formatNumber, formatTime } from './format';

describe('formatElapsed', () => {
	it.each([
		[0, 'under a minute'],
		[59_999, 'under a minute'],
		[60_000, '1m'],
		[2 * 3_600_000 + 9 * 60_000, '2h 9m'],
		[4 * 86_400_000 + 2 * 3_600_000 + 9 * 60_000 + 30_000, '4d 2h 9m'],
		[Number.NaN, 'under a minute']
	])('%d ms → %s', (ms, out) => {
		expect(formatElapsed(ms)).toBe(out);
	});
});

describe('dates and times', () => {
	const ts = Date.UTC(2026, 10, 4, 16, 44);
	it('formats dates as "4 Nov 2026"', () => {
		expect(formatDate(ts, 'UTC')).toBe('4 Nov 2026');
		expect(formatDate(Date.UTC(2026, 8, 1), 'UTC')).toBe('1 Sep 2026');
	});
	it('names the zone with the time', () => {
		expect(formatTime(ts, 'UTC')).toBe('16:44 UTC');
		expect(formatTime(ts, 'Europe/Budapest')).toBe('17:44 CET');
		expect(formatDateTime(ts, 'Europe/Budapest')).toBe('4 Nov 2026, 17:44 CET');
	});
	it('groups digits', () => {
		expect(formatNumber(1234567)).toBe('1,234,567');
	});
});
