<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChartNoAxesColumn } from '@lucide/svelte';
	import AsOf from '../components/AsOf.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import type { Frame } from './types';

	/**
	 * Fishnet's chart frame: a Card with the readout in the head, the chart (or its table twin when the page's
	 * view is "tables") in the body, and the source note plus the as-of time in the foot. `empty` swaps the body
	 * for an EmptyState that names what is missing; the frame itself always renders.
	 */
	type Props = Frame & {
		href?: string;
		empty?: boolean;
		readout?: Snippet;
		chart: Snippet;
		table: Snippet;
	};
	let {
		title,
		href,
		sub,
		note,
		asOf,
		stale = false,
		timeZone,
		view = 'charts',
		empty = false,
		emptyTitle = 'Nothing recorded yet',
		emptyLine,
		readout,
		chart,
		table
	}: Props = $props();
</script>

<section class="fp-card fp-chart">
	<header class="fp-card__head">
		<div>
			<h3 class="fp-card__title">
				{#if href}<a {href}>{title}</a>{:else}{title}{/if}
			</h3>
			{#if sub}<p class="fp-card__sub">{sub}</p>{/if}
		</div>
		{#if readout && !empty}<div class="fp-card__readout" aria-live="polite">{@render readout()}</div>{/if}
	</header>
	<div class="fp-card__body">
		{#if empty}
			<EmptyState title={emptyTitle} line={emptyLine} icon={ChartNoAxesColumn} />
		{:else if view === 'tables'}
			{@render table()}
		{:else}
			{@render chart()}
		{/if}
	</div>
	{#if note || asOf}
		<footer class="fp-card__foot">
			<span>{note ?? ''}</span>
			{#if asOf}<AsOf at={asOf} {timeZone} {stale} />{/if}
		</footer>
	{/if}
</section>
