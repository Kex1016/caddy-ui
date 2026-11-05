<script lang="ts">
	import { known, lastIndex, maxOf } from './scale';
	import type { Point } from './types';

	/** An inline trend with no frame and no axes; lives inside a StatTile. Fewer than two points draw a flat line. */
	type Props = { points: Point[]; label: string; width?: number; height?: number };
	let { points, label, width = 120, height = 28 }: Props = $props();

	const vals = $derived(points.map(([, v]) => v));
	const geom = $derived.by(() => {
		const n = vals.length;
		const top = maxOf(vals) || 1;
		const x = (i: number) => 1 + ((width - 6) * i) / Math.max(1, n - 1);
		const y = (v: number) => height - 3 - ((height - 6) * v) / top;
		let line = '';
		let area = '';
		let run: [number, number][] = [];
		const flush = () => {
			if (!run.length) return;
			const seg = run.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(2)},${b.toFixed(2)}`).join('');
			line += seg;
			area += `${seg}L${(run[run.length - 1] as [number, number])[0].toFixed(2)},${height - 1}L${(run[0] as [number, number])[0].toFixed(2)},${height - 1}Z`;
			run = [];
		};
		vals.forEach((v, i) => (v === null ? flush() : run.push([x(i), y(v)])));
		flush();
		const li = lastIndex(vals);
		return { line, area, dot: li >= 0 ? { cx: x(li), cy: y(vals[li] as number) } : null };
	});
</script>

<svg class="fp-spark" {width} {height} viewBox="0 0 {width} {height}" role="img" aria-label={label}>
	{#if known(vals) < 2}
		<line class="fp-spark__flat" x1="0" y1={height / 2} x2={width} y2={height / 2} />
	{:else}
		<path class="fp-spark__area" d={geom.area} />
		<path class="fp-spark__line" d={geom.line} />
		{#if geom.dot}<circle class="fp-spark__dot" cx={geom.dot.cx} cy={geom.dot.cy} r="3" />{/if}
	{/if}
</svg>
