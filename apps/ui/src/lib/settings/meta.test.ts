import { describe, expect, it } from 'vitest';
import type { EditableSetting } from '$lib/api/settings';
import { FIELDS, SECTION_KEYS, fallback, rowsOlderThan, sourceLabel, startValue } from './meta';

const DAY = 86_400_000;
const row = (over: Partial<EditableSetting>): EditableSetting => ({
	key: 'CADDY_UI_PROBE_INTERVAL',
	editable: true,
	value: '30s',
	source: 'default',
	env: null,
	default: '30s',
	saved: null,
	...over
});

describe('Settings page labels', () => {
	it('labels every editable setting and puts each in exactly one section', () => {
		const keys = Object.values(SECTION_KEYS).flat();
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys.sort()).toEqual(Object.keys(FIELDS).sort());
	});

	it('starts the form with the saved text, else the value in force', () => {
		expect(startValue(row({ saved: '2m', value: '2m', source: 'saved' }))).toBe('2m');
		// A saved value that is ignored is still what the person typed, so they can fix it.
		expect(startValue(row({ saved: 'soon', value: '30s', ignoredReason: 'bad' }))).toBe('soon');
		expect(startValue(row({ key: 'CADDY_UI_PUBLIC_URL', value: null, default: null }))).toBe('');
		// CADDY_UI_SETTINGS_IGNORE: the form shows what is in force.
		expect(startValue(row({ saved: '2m', value: '30s', ignoredReason: 'ignore is on' }), true)).toBe('30s');
	});

	it('names what a reset goes back to', () => {
		expect(fallback(row({ env: '1m' }))).toEqual({ value: '1m', from: 'env' });
		expect(fallback(row({}))).toEqual({ value: '30s', from: 'default' });
		expect(sourceLabel(row({ source: 'saved' }))).toBe('Saved here');
		expect(sourceLabel(row({ source: 'env' }))).toBe('From the environment');
	});
});

describe('rowsOlderThan', () => {
	const now = 100 * DAY;
	it('estimates the share of rows before the new cutoff', () => {
		// 90 days of rows, keep 30: two thirds go.
		expect(rowsOlderThan(9_000, now - 90 * DAY, 30, now)).toBe(6_000);
	});
	it('is zero when nothing is old enough or the table is empty', () => {
		expect(rowsOlderThan(9_000, now - 10 * DAY, 30, now)).toBe(0);
		expect(rowsOlderThan(0, now - 90 * DAY, 30, now)).toBe(0);
		expect(rowsOlderThan(9_000, null, 30, now)).toBe(0);
	});
});
