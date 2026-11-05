<script lang="ts">
	import { pointTime } from './scale';
	import { STRIP_CLASS, cellBoxes, cellWord } from './strip';
	import type { StripCell } from './types';

	/** The bare strip of an UptimeStrip, one cell per bucket; used inside the card and in upstream lists. */
	type Props = {
		cells: StripCell[];
		stepMs: number;
		timeZone: string;
		label: string;
		height?: number;
		active?: number | null;
	};
	let { cells, stepMs, timeZone, label, height = 28, active = $bindable(null) }: Props = $props();

	const W = 560;
	const boxes = $derived(cellBoxes(cells.length, W));

	function move(e: PointerEvent) {
		const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
		if (box.width === 0 || cells.length === 0) return;
		const x = ((e.clientX - box.left) / box.width) * W;
		active = Math.max(0, Math.min(cells.length - 1, Math.floor((x / W) * cells.length)));
	}
	function key(e: KeyboardEvent) {
		const from = active ?? cells.length - 1;
		if (e.key === 'ArrowLeft') active = Math.max(0, from - 1);
		else if (e.key === 'ArrowRight') active = Math.min(cells.length - 1, from + 1);
		else if (e.key === 'Escape') active = null;
		else return;
		e.preventDefault();
	}
	const title = (i: number) =>
		`${pointTime((cells[i] as StripCell).t, stepMs, timeZone)}: ${cellWord(cells[i] as StripCell)}`;
</script>

<!-- Fishnet: the chart is an image with a one-line description that is also focusable, so the arrow keys move
     the readout (which is aria-live). svelte-check flags focus and key handlers on role=img. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<svg
	class="fp-plot"
	viewBox="0 0 {W} {height}"
	{height}
	role="img"
	aria-label={label}
	tabindex="0"
	preserveAspectRatio="none"
	onpointermove={move}
	onpointerleave={() => (active = null)}
	onkeydown={key}
	onblur={() => (active = null)}
>
	{#each cells as c, i (c.t)}
		<rect
			class="{STRIP_CLASS[c.state]}{active === i ? ' fp-plot__strip--active' : ''}"
			x={(boxes[i] as { x: number }).x}
			y="0.5"
			width={(boxes[i] as { w: number }).w}
			height={height - 1}
			rx="1"><title>{title(i)}</title></rect
		>
	{/each}
</svg>
