<script lang="ts">
	/** The table twin of a chart: the same numbers it draws, one row per point. A missing value prints "—". */
	type Column = { key: string; label: string; num?: boolean };
	type Props = {
		columns: Column[];
		rows: Record<string, string | number | null | undefined>[];
		caption: string;
	};
	let { columns, rows, caption }: Props = $props();
</script>

<div class="fp-table__wrap">
	<table class="fp-table">
		<caption class="visually-hidden">{caption}</caption>
		<thead>
			<tr>
				{#each columns as c (c.key)}<th scope="col" class:num={c.num}>{c.label}</th>{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row, i (i)}
				<tr>
					{#each columns as c (c.key)}
						<td class:num={c.num}>{row[c.key] ?? '—'}</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.fp-table__wrap {
		max-height: 360px;
		overflow-y: auto;
	}
	thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
	}
</style>
