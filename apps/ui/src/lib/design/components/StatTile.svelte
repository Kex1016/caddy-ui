<script lang="ts">
	import type { Snippet } from 'svelte';

	/** A single number that is the point. The Sparkline under it arrives with the chart components (W7). */
	type Props = { label: string; value: string; unit?: string; note?: string; href?: string; spark?: Snippet };
	let { label, value, unit, note, href, spark }: Props = $props();
</script>

<svelte:element this={href ? 'a' : 'div'} class="fp-tile" {href}>
	<span class="fp-tile__label">{label}</span>
	<span class="fp-tile__value"
		>{value}{#if unit}<small>{unit}</small>{/if}</span
	>
	{#if note}<span class="fp-tile__note">{note}</span>{/if}
	{#if spark}<div class="fp-tile__spark">{@render spark()}</div>{/if}
</svelte:element>

<style>
	a.fp-tile {
		color: inherit;
	}
	a.fp-tile:hover {
		border-color: var(--line);
		background: var(--raised);
		text-decoration: none;
	}
</style>
