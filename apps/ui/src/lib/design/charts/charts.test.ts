import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BarList from './BarList.svelte';
import LineChart from './LineChart.svelte';
import UptimeStrip from './UptimeStrip.svelte';
import { indexAt, known, lastIndex, niceTicks, paths, plotLeft, scale, timeTicks } from './scale';
import { cellBoxes, cellWord } from './strip';
import type { Point, StripCell } from './types';
import { viewParam, withParam } from './url';

describe('niceTicks', () => {
	it.each([
		[0, [0, 1]],
		[7, [0, 2, 4, 6, 8]],
		[16, [0, 5, 10, 15, 20]],
		[100, [0, 25, 50, 75, 100]],
		[0.3, [0, 0.1, 0.2, 0.3]],
		[1234, [0, 500, 1000, 1500]]
	])('covers %d with nice steps', (max, ticks) => {
		expect(niceTicks(max)).toEqual(ticks);
	});
	it('always reaches the maximum', () => {
		for (const max of [1, 3, 9, 11, 99, 101, 4321, 0.07]) {
			const t = niceTicks(max);
			expect(t[t.length - 1]).toBeGreaterThanOrEqual(max);
		}
	});
});

describe('paths', () => {
	const s = scale(5, 10, 30);
	it('breaks the line at nulls', () => {
		const { line, area } = paths([1, 2, null, 4, 5], s);
		expect(line.match(/M/g)).toHaveLength(2);
		expect(area.match(/Z/g)).toHaveLength(2);
	});
	it('draws nothing for an all-null series', () => {
		expect(paths([null, null], s)).toEqual({ line: '', area: '' });
	});
	it('maps the first and last bucket to the plot edges', () => {
		expect(s.x(0)).toBe(30);
		expect(s.x(4)).toBe(550);
		expect(s.y(0)).toBe(138);
		expect(s.y(10)).toBe(8);
	});
	it('finds the bucket under the pointer', () => {
		expect(indexAt(30, 5, 30)).toBe(0);
		expect(indexAt(550, 5, 30)).toBe(4);
		expect(indexAt(9999, 5, 30)).toBe(4);
		expect(indexAt(300, 5, 30)).toBe(2);
	});
	it('counts known values and finds the last one', () => {
		expect(known([null, 1, 0, null])).toBe(2);
		expect(lastIndex([1, 2, null])).toBe(1);
		expect(lastIndex([null])).toBe(-1);
	});
	it('leaves room for the longest tick label', () => {
		expect(plotLeft(['0', '1,500'])).toBeGreaterThan(plotLeft(['0', '5']));
	});
});

describe('timeTicks', () => {
	const hour = Array.from({ length: 60 }, (_, i) => Date.UTC(2026, 10, 4, 16, i));
	it('labels clock times within a day, first and last included', () => {
		const t = timeTicks(hour, 60_000, 'UTC');
		expect(t[0]).toEqual({ i: 0, label: '16:00' });
		expect(t[t.length - 1]).toEqual({ i: 59, label: '16:59' });
		expect(t.length).toBeLessThanOrEqual(6);
	});
	it('labels days beyond a day', () => {
		const week = Array.from({ length: 168 }, (_, i) => Date.UTC(2026, 10, 1) + i * 3_600_000);
		expect(timeTicks(week, 3_600_000, 'UTC')[0]?.label).toBe('1 Nov');
	});
});

describe('strip', () => {
	it('names each state in words', () => {
		expect(cellWord({ t: 0, state: 'up', upRatio: 1 })).toBe('up');
		expect(cellWord({ t: 0, state: 'mixed', upRatio: 0.5 })).toBe('up 50% of the time');
		expect(cellWord({ t: 0, state: 'unknown', upRatio: null })).toBe('no data');
	});
	it('fits cells across the width', () => {
		const b = cellBoxes(96, 560);
		const lastBox = b[95] as { x: number; w: number };
		expect(lastBox.x + lastBox.w).toBeLessThanOrEqual(560);
		expect(cellBoxes(288, 560)[0]?.w).toBeGreaterThan(0);
	});
});

describe('url params', () => {
	const url = new URL('http://x/sites/abc?range=7d&view=tables');
	it('sets and clears one parameter, keeping the rest', () => {
		expect(withParam(url, 'range', '1h')).toBe('/sites/abc?range=1h&view=tables');
		expect(withParam(url, 'view', null)).toBe('/sites/abc?range=7d');
	});
	it('reads the view', () => {
		expect(viewParam(url)).toBe('tables');
		expect(viewParam(new URL('http://x/'))).toBe('charts');
	});
});

const t0 = Date.UTC(2026, 10, 4, 16, 0);
const pts = (vals: (number | null)[]): Point[] => vals.map((v, i) => [t0 + i * 60_000, v]);
const frame = { timeZone: 'UTC', asOf: t0 + 3_600_000, title: 'Requests', note: "From Caddy's /metrics" };

describe('LineChart (server render)', () => {
	it('draws the SVG, readout and source note', () => {
		const { body } = render(LineChart, {
			props: {
				...frame,
				label: 'Requests',
				series: { source: 'metrics', points: pts([1, 4, null, 2, 3]) },
				format: String,
				stepMs: 60_000
			}
		});
		expect(body).toContain('class="fp-plot"');
		expect(body).toContain('role="img"');
		expect(body).toContain('highest 4 at 16:01 UTC');
		expect(body).toContain('<b>3</b>');
		expect(body).toContain('16:04 UTC');
		expect(body).toContain('From Caddy');
		expect(body).toContain('as of 4 Nov 2026, 17:00 UTC');
	});
	it('renders the table twin with the same numbers', () => {
		const { body } = render(LineChart, {
			props: {
				...frame,
				view: 'tables',
				label: 'p95',
				series: { source: 'metrics', points: pts([10, null, 30]) },
				shadow: { label: 'p50', series: { source: 'metrics', points: pts([5, null, 15]) } },
				format: (v: number) => `${v} ms`,
				stepMs: 60_000
			}
		});
		expect(body).not.toContain('class="fp-plot"');
		expect(body).toMatch(/<th scope="col" class="[^"]*num">p95<\/th>/);
		expect(body).toContain('<td class="num">30 ms</td>');
		expect(body).toContain('<td class="num">15 ms</td>');
		expect(body).toContain('<td class="num">—</td>');
	});
	it('keeps the frame and shows the empty state with fewer than two points', () => {
		const { body } = render(LineChart, {
			props: {
				...frame,
				emptyTitle: 'No source for this chart',
				emptyLine: 'Add metrics { per_host }',
				label: 'Requests',
				series: { source: null, points: pts([null, null, 1]) },
				format: String,
				stepMs: 60_000
			}
		});
		expect(body).toContain('fp-card');
		expect(body).toContain('No source for this chart');
		expect(body).toContain('per_host');
		expect(body).not.toContain('class="fp-plot"');
	});
	it('says "last good data" when stale', () => {
		const { body } = render(LineChart, {
			props: {
				...frame,
				stale: true,
				label: 'Requests',
				series: { source: 'metrics', points: pts([1, 2]) },
				format: String,
				stepMs: 60_000
			}
		});
		expect(body).toContain('last good data as of');
	});
});

describe('UptimeStrip and BarList (server render)', () => {
	const cells: StripCell[] = [
		{ t: t0, state: 'up', upRatio: 1 },
		{ t: t0 + 60_000, state: 'mixed', upRatio: 0.25 },
		{ t: t0 + 120_000, state: 'down', upRatio: 0 },
		{ t: t0 + 180_000, state: 'unknown', upRatio: null }
	];
	it('draws a cell per bucket with legend words', () => {
		const { body } = render(UptimeStrip, {
			props: { ...frame, title: 'Uptime', cells, ratio: 0.4, stepMs: 60_000, from: t0, to: t0 + 240_000 }
		});
		expect(body.match(/<rect/g)).toHaveLength(4);
		expect(body).toContain('fp-plot__strip--none');
		expect(body).toContain('partly down');
		expect(body).toContain('40% up');
	});
	it('lists rows with bars scaled to the longest, and an empty state without rows', () => {
		const rows = [
			{ key: 'a', label: '/a', v: 10, display: '10' },
			{ key: 'b', label: '/b', v: 5, display: '5' }
		];
		const { body } = render(BarList, {
			props: { ...frame, title: 'Top paths', valueLabel: 'Requests', rows }
		});
		expect(body).toContain('width: 100.0%');
		expect(body).toContain('width: 50.0%');
		const empty = render(BarList, {
			props: {
				...frame,
				title: 'Top paths',
				valueLabel: 'Requests',
				rows: [],
				emptyTitle: 'No access log data'
			}
		});
		expect(empty.body).toContain('No access log data');
	});
});
