<script lang="ts">
	import { formatDate, formatPercent } from '$lib/format';
	import ChartCard from './ChartCard.svelte';
	import DataTable from './DataTable.svelte';
	import StripPlot from './StripPlot.svelte';
	import { pointTime } from './scale';
	import { STRIP_WORD, cellWord } from './strip';
	import type { Frame, StripCell } from './types';

	/** A site's state over the range as Fishnet's UptimeStrip, with the uptime share in the readout. */
	type Props = Frame & { cells: StripCell[]; ratio: number | null; stepMs: number; from: number; to: number };
	let { cells, ratio, stepMs, from, to, ...frame }: Props = $props();

	let active: number | null = $state(null);
	const empty = $derived(cells.every((c) => c.state === 'unknown'));
	const label = $derived(
		`${frame.title}: ${ratio === null ? 'no data' : `up ${formatPercent(ratio)} of the time`} over ${cells.length} buckets`
	);
	const rows = $derived(
		cells.map((c) => ({
			when: pointTime(c.t, stepMs, frame.timeZone),
			state: cellWord(c),
			up: c.upRatio === null ? null : formatPercent(c.upRatio)
		}))
	);
</script>

<ChartCard
	{...frame}
	{empty}
	emptyLine={frame.emptyLine ?? 'Probes have not recorded a state in this range yet.'}
>
	{#snippet readout()}
		{#if active !== null && cells[active]}
			<b>{cellWord(cells[active] as StripCell)}</b><span
				>{pointTime((cells[active] as StripCell).t, stepMs, frame.timeZone)}</span
			>
		{:else}
			<b>{ratio === null ? 'no data' : `${formatPercent(ratio)} up`}</b><span
				>{formatDate(from, frame.timeZone)} – {formatDate(
					Math.min(to, frame.asOf ?? to),
					frame.timeZone
				)}</span
			>
		{/if}
	{/snippet}
	{#snippet chart()}
		<div class="fp-plot__wrap">
			<StripPlot {cells} {stepMs} timeZone={frame.timeZone} {label} height={40} bind:active />
			<div class="fp-plot__legend">
				<span><i class="fp-plot__key fp-strip__key--on"></i>{STRIP_WORD.up}</span>
				<span><i class="fp-plot__key fp-strip__key--some"></i>{STRIP_WORD.mixed}</span>
				<span><i class="fp-plot__key fp-strip__key--off"></i>{STRIP_WORD.down}</span>
				<span><i class="fp-plot__key fp-strip__key--unknown"></i>{STRIP_WORD.unknown}</span>
			</div>
		</div>
	{/snippet}
	{#snippet table()}
		<DataTable
			caption={frame.title}
			columns={[
				{ key: 'when', label: 'When' },
				{ key: 'state', label: 'State' },
				{ key: 'up', label: 'Up', num: true }
			]}
			{rows}
		/>
	{/snippet}
</ChartCard>

<style>
	:global(.fp-strip__key--some) {
		background: var(--warning-soft);
		border: 1px solid var(--warning);
	}
</style>
