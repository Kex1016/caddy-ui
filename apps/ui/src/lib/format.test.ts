import { afterEach, describe, expect, it } from 'vitest';
import {
	formatBytes,
	formatClock,
	formatCompact,
	formatDate,
	formatDateTime,
	formatDay,
	formatDayTime,
	formatElapsed,
	formatMs,
	formatNumber,
	formatPercent,
	formatTime,
	setDisplayFormat
} from './format';

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

describe('stats formatting', () => {
	it('formats bytes in decimal units', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(999)).toBe('999 B');
		expect(formatBytes(1500)).toBe('1.5 kB');
		expect(formatBytes(12_400_000)).toBe('12.4 MB');
		expect(formatBytes(3_210_000_000)).toBe('3.21 GB');
	});
	it('formats latency', () => {
		expect(formatMs(0.42)).toBe('0.42 ms');
		expect(formatMs(4.25)).toBe('4.3 ms');
		expect(formatMs(84.4)).toBe('84 ms');
		expect(formatMs(1240)).toBe('1.24 s');
	});
	it('never rounds an almost-perfect ratio to 100%', () => {
		expect(formatPercent(1)).toBe('100%');
		expect(formatPercent(0)).toBe('0%');
		expect(formatPercent(0.99996)).toBe('99.99%');
		expect(formatPercent(0.9935)).toBe('99.35%');
		expect(formatPercent(0.5)).toBe('50%');
		expect(formatPercent(0.1234)).toBe('12.3%');
		expect(formatPercent(0.00001)).toBe('<0.01%');
	});
	it('compacts counts for axes', () => {
		expect(formatCompact(950)).toBe('950');
		expect(formatCompact(1500)).toBe('1.5k');
		expect(formatCompact(25_000)).toBe('25k');
		expect(formatCompact(3_400_000)).toBe('3.4M');
	});
	it('formats chart ticks', () => {
		const ts = Date.UTC(2026, 10, 4, 16, 44);
		expect(formatClock(ts, 'Europe/Budapest')).toBe('17:44');
		expect(formatDay(ts, 'UTC')).toBe('4 Nov');
		expect(formatDayTime(ts, 'Europe/Budapest')).toBe('4 Nov, 17:44 CET');
	});
});

describe('display preferences', () => {
	const ts = Date.UTC(2026, 10, 4, 16, 44);
	const reset = () => setDisplayFormat({ clock: '24h', dateFormat: 'dmy' });
	afterEach(reset);

	it('writes the clock in 12 hours when asked', () => {
		setDisplayFormat({ clock: '12h', dateFormat: 'dmy' });
		expect(formatTime(ts, 'Europe/Budapest')).toBe('5:44 PM CET');
		expect(formatClock(ts, 'UTC')).toBe('4:44 PM');
		expect(formatDateTime(ts, 'UTC')).toBe('4 Nov 2026, 4:44 PM UTC');
	});

	it('writes dates in the chosen format, with and without the year', () => {
		setDisplayFormat({ clock: '24h', dateFormat: 'mdy' });
		expect(formatDate(ts, 'UTC')).toBe('Nov 4, 2026');
		expect(formatDay(ts, 'UTC')).toBe('Nov 4');
		setDisplayFormat({ clock: '24h', dateFormat: 'iso' });
		expect(formatDate(ts, 'UTC')).toBe('2026-11-04');
		expect(formatDay(ts, 'UTC')).toBe('11-04');
		expect(formatDayTime(ts, 'UTC')).toBe('11-04, 16:44 UTC');
	});

	it('keeps the defaults when nothing was set', () => {
		expect(formatDate(ts, 'UTC')).toBe('4 Nov 2026');
		expect(formatTime(ts, 'UTC')).toBe('16:44 UTC');
	});
});
