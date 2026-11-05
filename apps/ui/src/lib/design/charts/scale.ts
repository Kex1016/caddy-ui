import { formatClock, formatDay, formatDayTime, formatTime } from '$lib/format';
import type { Point } from './types';

/** Axis and path maths for the server-rendered SVG charts. Pure, so it is tested without a DOM. */

export const W = 560;
export const H = 160;
export const TOP = 8;
export const BASE = 138;
export const RIGHT = 550;

/** A "nice" axis: 0, then 4 steps of 1, 2, 2.5 or 5 × 10^n that cover `max`. */
export function niceTicks(max: number, steps = 4): number[] {
	if (!Number.isFinite(max) || max <= 0) return [0, 1];
	const raw = max / steps;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
	const out: number[] = [];
	for (let i = 0; i <= steps; i++) out.push(Math.round(step * i * 1e9) / 1e9);
	while (out.length > 2 && (out[out.length - 2] as number) >= max) out.pop();
	return out;
}

/** Left edge of the plot, wide enough for the longest tick label (11px mono ≈ 6.6px a glyph). */
export function plotLeft(labels: string[]): number {
	const longest = Math.max(1, ...labels.map((l) => l.length));
	return Math.ceil(longest * 6.6 + 10);
}

export type Scale = { x: (i: number) => number; y: (v: number) => number; left: number; top: number };

export function scale(n: number, top: number, left: number): Scale {
	const span = RIGHT - left;
	return {
		left,
		top,
		x: (i) => (n <= 1 ? RIGHT : left + (span * i) / (n - 1)),
		y: (v) => BASE - ((BASE - TOP) * v) / (top || 1)
	};
}

const r = (v: number) => Math.round(v * 100) / 100;

/** Line and area paths with a break wherever a value is null, so a gap in the data is a gap in the line. */
export function paths(values: (number | null)[], s: Scale): { line: string; area: string } {
	let line = '';
	let area = '';
	let run: [number, number][] = [];
	const flush = () => {
		if (run.length === 0) return;
		const seg = run.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)},${r(y)}`).join('');
		line += seg;
		const first = run[0] as [number, number];
		const last = run[run.length - 1] as [number, number];
		area += `${seg}L${r(last[0])},${BASE}L${r(first[0])},${BASE}Z`;
		run = [];
	};
	values.forEach((v, i) => {
		if (v === null) flush();
		else run.push([s.x(i), s.y(v)]);
	});
	flush();
	return { line, area };
}

/** Index of the last non-null value, or -1. */
export function lastIndex(values: (number | null)[]): number {
	for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
	return -1;
}

export function known(values: (number | null)[]): number {
	return values.reduce<number>((n, v) => (v === null ? n : n + 1), 0);
}

/** Labels for the time axis: clock times inside a day, days beyond. At most `max` labels, evenly thinned. */
export function timeTicks(
	ts: number[],
	stepMs: number,
	timeZone: string,
	max = 6
): { i: number; label: string }[] {
	if (ts.length === 0) return [];
	const daily = stepMs >= 3_600_000;
	const fmt = (t: number) => (daily ? formatDay(t, timeZone) : formatClock(t, timeZone));
	const every = Math.max(1, Math.ceil((ts.length - 1) / (max - 1)));
	const out: { i: number; label: string }[] = [];
	for (let i = 0; i < ts.length; i += every) out.push({ i, label: fmt(ts[i] as number) });
	const lastI = ts.length - 1;
	const tail = out[out.length - 1] as { i: number };
	if (tail.i !== lastI) {
		if (lastI - tail.i < every / 2) out.pop();
		out.push({ i: lastI, label: fmt(ts[lastI] as number) });
	}
	return out;
}

/** The readout's time for one bucket: "17:44 CET" within a day, "4 Nov, 17:00 CET" beyond. */
export function pointTime(t: number, stepMs: number, timeZone: string): string {
	return stepMs >= 3_600_000 ? formatDayTime(t, timeZone) : formatTime(t, timeZone);
}

/** Max over one or more value lists, ignoring nulls. */
export function maxOf(...lists: (number | null)[][]): number {
	let m = 0;
	for (const l of lists) for (const v of l) if (v !== null && v > m) m = v;
	return m;
}

export const values = (points: Point[]) => points.map(([, v]) => v);
export const times = (points: Point[]) => points.map(([t]) => t);

/** Nearest bucket to a pointer x in viewBox units. */
export function indexAt(x: number, n: number, left: number): number {
	if (n <= 1) return 0;
	const i = Math.round(((x - left) / (RIGHT - left)) * (n - 1));
	return Math.max(0, Math.min(n - 1, i));
}
