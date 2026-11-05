<script lang="ts">
	import ChartCard from './ChartCard.svelte';
	import DataTable from './DataTable.svelte';
	import {
		BASE,
		H,
		RIGHT,
		TOP,
		W,
		indexAt,
		known,
		lastIndex,
		maxOf,
		niceTicks,
		paths,
		plotLeft,
		pointTime,
		scale,
		timeTicks,
		times,
		values
	} from './scale';
	import type { Frame, Series } from './types';

	/**
	 * A time series as Fishnet's LineChart: one `acc-viz` line with a 10% wash and a ringed end dot, an optional
	 * `faint` shadow series behind it (p50 behind p95, 4xx behind 5xx), gaps where the data is null. The readout
	 * shows the latest point at rest and follows the pointer and the arrow keys.
	 */
	type Props = Frame & {
		href?: string;
		series: Series;
		/** Name of the series in the legend and the table twin. */
		label: string;
		shadow?: { label: string; series: Series };
		format: (v: number) => string;
		tick?: (v: number) => string;
		stepMs: number;
	};
	let { series, label, shadow, format, tick, stepMs, ...frame }: Props = $props();

	const main = $derived(values(series.points));
	const back = $derived(shadow ? values(shadow.series.points) : null);
	const ts = $derived(times(series.points));
	const n = $derived(main.length);
	const ticks = $derived(niceTicks(maxOf(main, back ?? [])));
	const top = $derived(ticks[ticks.length - 1] as number);
	const tickLabels = $derived(ticks.map((v) => (tick ?? format)(v)));
	const s = $derived(scale(n, top, plotLeft(tickLabels)));
	const mainPath = $derived(paths(main, s));
	const backPath = $derived(back ? paths(back, s) : null);
	const xTicks = $derived(timeTicks(ts, stepMs, frame.timeZone));
	const last = $derived(lastIndex(main));
	const empty = $derived(known(main) < 2);

	let active: number | null = $state(null);
	const shown = $derived(active ?? last);
	const shownValue = $derived(shown >= 0 ? (main[shown] ?? null) : null);
	const peak = $derived.by(() => {
		let at = -1;
		main.forEach((v, i) => {
			if (v !== null && (at < 0 || v > (main[at] as number))) at = i;
		});
		return at;
	});
	const description = $derived(
		empty
			? `${frame.title}: not enough data`
			: `${frame.title}: ${known(main)} points from ${pointTime(ts[0] as number, stepMs, frame.timeZone)} to ${pointTime(
					ts[n - 1] as number,
					stepMs,
					frame.timeZone
				)}, highest ${format(main[peak] as number)} at ${pointTime(ts[peak] as number, stepMs, frame.timeZone)}`
	);

	function move(e: PointerEvent) {
		const svg = e.currentTarget as SVGSVGElement;
		const box = svg.getBoundingClientRect();
		if (box.width === 0) return;
		active = indexAt(((e.clientX - box.left) / box.width) * W, n, s.left);
	}
	function key(e: KeyboardEvent) {
		const from = active ?? last;
		if (e.key === 'ArrowLeft') active = Math.max(0, from - 1);
		else if (e.key === 'ArrowRight') active = Math.min(n - 1, from + 1);
		else if (e.key === 'Home') active = 0;
		else if (e.key === 'End') active = n - 1;
		else if (e.key === 'Escape') active = null;
		else return;
		e.preventDefault();
	}

	const rows = $derived(
		series.points.map(([t, v], i) => ({
			when: pointTime(t, stepMs, frame.timeZone),
			v: v === null ? null : format(v),
			shadow: back && back[i] !== null && back[i] !== undefined ? format(back[i] as number) : null
		}))
	);
	const columns = $derived([
		{ key: 'when', label: 'When' },
		{ key: 'v', label, num: true },
		...(shadow ? [{ key: 'shadow', label: shadow.label, num: true }] : [])
	]);
</script>

<ChartCard {...frame} {empty}>
	{#snippet readout()}
		<b>{shownValue === null ? 'no data' : format(shownValue)}</b><span
			>{shown >= 0
				? pointTime(ts[shown] as number, stepMs, frame.timeZone)
				: ''}{#if back && shown >= 0 && back[shown] !== null && back[shown] !== undefined}{` · ${shadow?.label} ${format(
					back[shown] as number
				)}`}{/if}</span
		>
	{/snippet}
	{#snippet chart()}
		<div class="fp-plot__wrap">
			<!-- Fishnet: the chart is an image with a one-line description that is also focusable, so the arrow keys move
			     the readout (which is aria-live). svelte-check flags focus and key handlers on role=img. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<svg
				class="fp-plot"
				viewBox="0 0 {W} {H}"
				height={H}
				role="img"
				aria-label={description}
				tabindex="0"
				onpointermove={move}
				onpointerleave={() => (active = null)}
				onkeydown={key}
				onblur={() => (active = null)}
			>
				{#each ticks as v, i (i)}
					<line
						class={i === 0 ? 'fp-plot__base' : 'fp-plot__grid'}
						x1={s.left}
						x2={RIGHT}
						y1={s.y(v)}
						y2={s.y(v)}
					/>
					<text class="fp-plot__tick" x={s.left - 6} y={s.y(v) + 4} text-anchor="end">{tickLabels[i]}</text>
				{/each}
				{#each xTicks as t, i (t.i)}
					<text
						class="fp-plot__tick"
						x={s.x(t.i)}
						y={H - 7}
						text-anchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{t.label}</text
					>
				{/each}
				{#if backPath}<path class="fp-plot__line fp-plot__line--shadow" d={backPath.line} />{/if}
				<path class="fp-plot__area" d={mainPath.area} />
				<path class="fp-plot__line" d={mainPath.line} />
				{#if active !== null}
					<line class="fp-plot__cursor" x1={s.x(active)} x2={s.x(active)} y1={TOP} y2={BASE} />
					{#if back && back[active] !== null && back[active] !== undefined}
						<circle
							class="fp-plot__dot fp-plot__dot--shadow"
							cx={s.x(active)}
							cy={s.y(back[active] as number)}
							r="3"
						/>
					{/if}
				{/if}
				{#if shown >= 0 && shownValue !== null}
					<circle class="fp-plot__dot" cx={s.x(shown)} cy={s.y(shownValue)} r="4" />
				{/if}
			</svg>
			{#if shadow}
				<div class="fp-plot__legend">
					<span><i class="fp-plot__key fp-plot__key--line"></i>{label}</span>
					<span><i class="fp-plot__key fp-plot__key--shadow"></i>{shadow.label}</span>
				</div>
			{/if}
		</div>
	{/snippet}
	{#snippet table()}
		<DataTable caption={frame.title} {columns} {rows} />
	{/snippet}
</ChartCard>
