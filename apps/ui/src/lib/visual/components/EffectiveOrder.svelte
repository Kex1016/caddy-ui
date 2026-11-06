<script lang="ts">
	import { Notice } from '$lib/design/components';
	import type { OrderView } from '../order';

	type Props = { view: OrderView; onselect?: (fileIndex: number) => void };
	let { view, onselect }: Props = $props();
</script>

<div class="ord">
	{#if view.literal}
		<p class="t-caption t-muted">Inside <code>route</code> Caddy runs directives in file order.</p>
	{:else if view.differs}
		<p class="t-caption t-muted">
			Caddy sorts handlers by its directive order, not by file order. This is the order it runs them in.
		</p>
	{:else}
		<p class="t-caption t-muted">File order and Caddy’s run order agree.</p>
	{/if}
	{#if view.rows.length}
		<ol class="ord__list">
			{#each view.rows as row (row.fileIndex)}
				<li class="ord__row" class:ord__row--aside={row.position < 0}>
					<button type="button" class="ord__btn" onclick={() => onselect?.(row.fileIndex)}>
						<span class="t-mono ord__name">{row.name}</span>
						{#if row.node.matcher}<span class="fp-tag">{row.node.matcher.text}</span>{/if}
						{#if row.note}<span class="t-caption ord__note">{row.note}</span>{/if}
					</button>
				</li>
			{/each}
		</ol>
	{/if}
	{#if view.unordered.length}
		<Notice kind="warning">
			Not in Caddy’s directive order: {view.unordered.join(', ')}. Add an <code>order</code> line to the
			global options, or put it inside a <code>route</code> block.
		</Notice>
	{/if}
</div>

<style>
	.ord {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.ord__list {
		margin: 0;
		padding-left: var(--space-5);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.ord__row--aside {
		color: var(--muted);
	}
	.ord__btn {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		border: 0;
		background: transparent;
		padding: 2px var(--space-2);
		border-radius: var(--radius-sm);
		color: inherit;
		cursor: pointer;
		text-align: left;
	}
	.ord__btn:hover {
		background: var(--hover-tint);
	}
	.ord__name {
		font-size: 13px;
	}
	.ord__note {
		color: var(--muted);
	}
</style>
