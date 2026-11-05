<script lang="ts">
	import { PageHero } from '$lib/design/components';
	import { formatDateTime } from '$lib/format';

	let { data } = $props();
</script>

<PageHero
	kicker="System"
	title="About"
	lede="The version of this UI and the configuration it was started with."
/>
<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">This instance</h2></div>
	<div class="fp-panel">
		<p class="t-body">
			Caddy UI <span class="t-mono">{data.version}</span>, running since {formatDateTime(
				data.startedAt,
				data.timeZone
			)}.
		</p>
	</div>
</section>
<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">Configuration</h2></div>
	<div class="fp-panel fp-table__wrap">
		<table class="fp-table">
			<caption class="visually-hidden">Environment variables this instance read at start</caption>
			<thead><tr><th scope="col">Variable</th><th scope="col">Value</th></tr></thead>
			<tbody>
				{#each data.rows as row (row.name)}
					<tr><td class="t-mono">{row.name}</td><td class="t-mono">{row.value}</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>
