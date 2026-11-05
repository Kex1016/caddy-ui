import { formatPercent } from '$lib/format';
import type { StripCell, StripState } from './types';

/** Fishnet's UptimeStrip classes: up in the accent heat step, down in error-soft, mixed in warning-soft, no data outlined. */
export const STRIP_CLASS: Record<StripState, string> = {
	up: 'fp-plot__cell fp-plot__cell--3',
	mixed: 'fp-plot__cell fp-plot__strip--some',
	down: 'fp-plot__cell fp-plot__strip--none',
	unknown: 'fp-plot__cell fp-plot__strip--unknown'
};

/** The words that travel with each colour, in the legend, the readout and the table twin. */
export const STRIP_WORD: Record<StripState, string> = {
	up: 'up',
	mixed: 'partly down',
	down: 'down',
	unknown: 'no data'
};

export function cellWord(c: StripCell): string {
	if (c.state === 'mixed' && c.upRatio !== null) return `up ${formatPercent(c.upRatio)} of the time`;
	return STRIP_WORD[c.state];
}

/** Geometry for n cells across `width`: a 1px gap while cells are wide enough to show one. */
export function cellBoxes(n: number, width: number): { x: number; w: number }[] {
	if (n === 0) return [];
	const pitch = width / n;
	const gap = pitch >= 4 ? 1 : pitch >= 2 ? 0.5 : 0;
	return Array.from({ length: n }, (_, i) => ({
		x: Math.round((i * pitch + gap / 2) * 100) / 100,
		w: Math.max(0.5, Math.round((pitch - gap) * 100) / 100)
	}));
}
