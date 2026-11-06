<script lang="ts">
	import { diffLines, diffStats, hunks } from '$lib/diff';

	type Props = { before: string; after: string; beforeLabel?: string; label?: string };
	let { before, after, beforeLabel = 'the file on disk', label = 'Line differences' }: Props = $props();

	const lines = $derived(diffLines(before, after));
	const stats = $derived(diffStats(lines));
	const shown = $derived(hunks(lines));
</script>

{#if stats.added + stats.removed === 0}
	<p class="t-ui t-muted">No changes: the text is identical to {beforeLabel}.</p>
{:else}
	<p class="t-ui t-muted">
		Compared with {beforeLabel}: <span class="add-ink">+{stats.added}</span>
		<span class="del-ink">−{stats.removed}</span> lines.
	</p>
	<!-- tabindex: the diff scrolls, so keyboard users must be able to focus it to scroll (WCAG 2.1.1). -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="diff" role="table" aria-label={label} tabindex="0">
		{#each shown as hunk, h (h)}
			{#if hunk.skippedBefore}
				<div class="diff__skip" role="row">
					<span role="cell">⋯ {hunk.skippedBefore} unchanged lines</span>
				</div>
			{/if}
			{#each hunk.lines as line, k (k)}
				<div class="diff__row diff__row--{line.kind}" role="row">
					<span class="diff__no" role="cell">{line.oldLine ?? ''}</span>
					<span class="diff__no" role="cell">{line.newLine ?? ''}</span>
					<span
						class="diff__sign"
						role="cell"
						aria-label={line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : 'unchanged'}
						>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span
					>
					<span class="diff__text" role="cell">{line.text}</span>
				</div>
			{/each}
		{/each}
	</div>
{/if}

<style>
	.diff {
		font: 400 13px/20px var(--font-mono);
		background: var(--sunk);
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-lg);
		overflow: auto;
		max-height: 64vh;
	}
	.diff__row,
	.diff__skip {
		display: grid;
		grid-template-columns: 4.5ch 4.5ch 2ch 1fr;
		white-space: pre;
		tab-size: 4;
	}
	.diff__skip {
		grid-template-columns: 1fr;
		padding: 0 var(--space-3);
		color: var(--faint);
	}
	.diff__no {
		text-align: right;
		padding-right: 0.5ch;
		color: var(--faint);
		user-select: none;
	}
	.diff__sign {
		text-align: center;
		user-select: none;
	}
	.diff__row--add {
		background: var(--success-soft);
	}
	.diff__row--del {
		background: var(--error-soft);
	}
	.add-ink {
		color: var(--success-ink, var(--success));
	}
	.del-ink {
		color: var(--error-ink, var(--error));
	}
</style>
