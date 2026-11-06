import { describe, expect, it } from 'vitest';
import { parseDuration } from './duration';

describe('parseDuration', () => {
	it.each([
		['30s', 30_000],
		['15m', 900_000],
		['1h', 3_600_000],
		['1h30m', 5_400_000],
		['500ms', 500],
		['1.5s', 1500],
		['2d', 172_800_000],
		['45', 45_000],
		[' 10s ', 10_000]
	])('reads %s', (input, ms) => {
		expect(parseDuration(input)).toBe(ms);
	});

	it.each(['', 'abc', '10x', '1h foo', 's', '-5s', '1h 30m'])('rejects %j', (input) => {
		expect(parseDuration(input)).toBeNull();
	});
});
