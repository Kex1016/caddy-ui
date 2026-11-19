<script lang="ts">
	/** The Sites table while its rows stream in: the real header and one `fp-skel` row per site block. */
	let { rows, dns = false }: { rows: number; dns?: boolean } = $props();
	const n = $derived(Math.max(1, Math.min(rows, 12)));
	const cols = $derived(dns ? 8 : 7);
</script>

<div class="fp-panel fp-table__wrap" aria-busy="true">
	<table class="fp-table">
		<caption class="visually-hidden">Loading the site list</caption>
		<thead>
			<tr>
				<th scope="col">Status</th>
				<th scope="col">Site</th>
				<th scope="col">Since</th>
				<th scope="col" class="num">Upstreams</th>
				<th scope="col" class="num">24 h</th>
				<th scope="col" class="num">Cert</th>
				{#if dns}<th scope="col">DNS</th>{/if}
				<th scope="col"><span class="visually-hidden">Actions</span></th>
			</tr>
		</thead>
		<tbody>
			{#each { length: n }, i (i)}
				<tr>
					{#each { length: cols }, c (c)}
						<td><span class="fp-skel cell" class:wide={c === 1}></span></td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.cell {
		height: 14px;
		width: 48px;
		border-radius: var(--radius-sm);
	}
	.wide {
		width: 180px;
		max-width: 100%;
	}
</style>
