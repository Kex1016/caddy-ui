<script lang="ts">
	/**
	 * A StatTile whose number is still streaming in: the real label, `fp-skel` where the value goes, and room for
	 * the Sparkline when the tile will have one, so the row keeps its height when the number lands.
	 */
	let { label, spark = false }: { label: string; spark?: boolean } = $props();
</script>

<div class="fp-tile" aria-busy="true">
	<span class="fp-tile__label">{label}</span>
	<span class="fp-skel value"><span class="visually-hidden">Loading</span></span>
	<span class="fp-skel note"></span>
	{#if spark}<div class="fp-tile__spark"><span class="fp-skel line"></span></div>{/if}
</div>

<style>
	.value {
		height: 28px;
		width: 60%;
		margin: 2px 0;
		border-radius: var(--radius-sm);
	}
	.note {
		height: 12px;
		width: 80%;
		border-radius: var(--radius-sm);
	}
	.line {
		height: 28px;
		width: 120px;
		border-radius: var(--radius-sm);
	}
</style>
