import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, hunks } from './diff';

describe('diffLines', () => {
	it('marks additions, removals and unchanged lines with their line numbers', () => {
		const d = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
		expect(d).toEqual([
			{ kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
			{ kind: 'del', text: 'b', oldLine: 2 },
			{ kind: 'add', text: 'B', newLine: 2 },
			{ kind: 'same', text: 'c', oldLine: 3, newLine: 3 },
			{ kind: 'add', text: 'd', newLine: 4 }
		]);
		expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
	});

	it('handles empty sides and identical text', () => {
		expect(diffLines('', 'x\n')).toEqual([{ kind: 'add', text: 'x', newLine: 1 }]);
		expect(diffStats(diffLines('same\n', 'same\n'))).toEqual({ added: 0, removed: 0 });
	});

	it('folds long unchanged runs into hunks', () => {
		const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
		const next = old.replace('l10', 'L10');
		const h = hunks(diffLines(old, next), 2);
		expect(h).toHaveLength(1);
		expect(h[0]!.skippedBefore).toBe(8);
		expect(h[0]!.lines.map((l) => l.text)).toEqual(['l8', 'l9', 'l10', 'L10', 'l11', 'l12']);
	});
});
