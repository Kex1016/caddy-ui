<script lang="ts">
	/**
	 * A chart or list card whose data is still streaming in: the real title and subtitle, and Fishnet's `fp-skel`
	 * ground where the plot or rows will be. Same frame as ChartCard, so nothing moves when the data lands.
	 */
	type Props = { title: string; sub?: string; kind?: 'chart' | 'list' };
	let { title, sub, kind = 'chart' }: Props = $props();
</script>

<section class="fp-card fp-chart" aria-busy="true">
	<header class="fp-card__head">
		<div>
			<h3 class="fp-card__title">{title}</h3>
			{#if sub}<p class="fp-card__sub">{sub}</p>{/if}
		</div>
	</header>
	<div class="fp-card__body">
		<span class="visually-hidden">Loading {title.toLowerCase()}</span>
		{#if kind === 'chart'}
			<span class="fp-skel plot"></span>
		{:else}
			{#each [0.9, 0.7, 0.55, 0.4, 0.3] as w (w)}
				<span class="fp-skel line" style:width="{w * 100}%"></span>
			{/each}
		{/if}
	</div>
</section>

<style>
	.plot {
		height: 184px;
	}
	.line {
		height: 14px;
		margin: var(--space-3) 0;
		border-radius: var(--radius-sm);
	}
</style>
