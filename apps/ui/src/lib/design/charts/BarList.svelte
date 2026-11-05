<script lang="ts">
	import ChartCard from './ChartCard.svelte';
	import DataTable from './DataTable.svelte';
	import type { BarRow, Frame } from './types';

	/** A ranked list with a bar under each label, scaled to the longest; Fishnet's BarList. */
	type Props = Frame & { href?: string; rows: BarRow[]; valueLabel: string; highlight?: string };
	let { rows, valueLabel, highlight, ...frame }: Props = $props();

	const max = $derived(Math.max(0, ...rows.map((r) => r.v)));
	const lead = $derived(rows.find((r) => r.key === highlight) ?? rows[0]);
</script>

<ChartCard {...frame} empty={rows.length === 0}>
	{#snippet readout()}
		{#if lead}<b>{lead.display}</b><span>{lead.label}</span>{/if}
	{/snippet}
	{#snippet chart()}
		<ol class="fp-rows" class:fp-rows--hi={highlight !== undefined}>
			{#each rows as row, i (row.key)}
				<li>
					<svelte:element
						this={row.href ? 'a' : 'div'}
						href={row.href}
						class="fp-row bar-row"
						aria-current={row.key === highlight ? 'true' : undefined}
					>
						<span class="fp-row__rank" class:fp-row__rank--top={i < 3}>{i + 1}</span>
						<span class="fp-row__name fp-row__name--bar">
							<span class="fp-row__text" title={row.label}>{row.label}</span>
							{#if row.sub}<span class="fp-row__sub">{row.sub}</span>{/if}
							<span class="fp-bar" aria-hidden="true"
								><i style="width: {max > 0 ? ((row.v / max) * 100).toFixed(1) : 0}%"></i></span
							>
						</span>
						<span class="fp-row__value">{row.display}</span>
					</svelte:element>
				</li>
			{/each}
		</ol>
	{/snippet}
	{#snippet table()}
		<DataTable
			caption={frame.title}
			columns={[
				{ key: 'rank', label: '#', num: true },
				{ key: 'label', label: 'Name' },
				{ key: 'value', label: valueLabel, num: true }
			]}
			rows={rows.map((r, i) => ({
				rank: i + 1,
				label: r.sub ? `${r.label} (${r.sub})` : r.label,
				value: r.display
			}))}
		/>
	{/snippet}
</ChartCard>

<style>
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.bar-row {
		grid-template-columns: 28px minmax(0, 1fr) auto;
	}
</style>
