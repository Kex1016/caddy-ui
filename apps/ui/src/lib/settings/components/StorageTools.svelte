<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { Notice, Tag } from '$lib/design/components';
	import { formatBytes, formatDateTime } from '$lib/format';
	import type { MaintenanceState, TaskState } from '../types';

	/**
	 * Storage tools (docs/settings-and-perf-plan.md §3, Data and storage): prune now, compact the database and
	 * download a backup. Prune and compact run in the background on the server; the page checks back every two
	 * seconds while one runs.
	 */
	type Props = {
		jobs: MaintenanceState;
		timeZone: string;
		retentionDays: string | null;
		dbBytes: number;
		freeInFileBytes: number;
		volumeFreeBytes: number | null;
	};
	let { jobs, timeZone, retentionDays, dbBytes, freeInFileBytes, volumeFreeBytes }: Props = $props();

	let compactError = $state<string | null>(null);
	let sending = $state<'prune' | 'compact' | null>(null);

	const running = $derived(jobs.prune.running || jobs.compact.running);
	$effect(() => {
		if (!running) return;
		const t = setInterval(() => void invalidate('settings:tools'), 2000);
		return () => clearInterval(t);
	});

	const roomToCompact = $derived(volumeFreeBytes === null || volumeFreeBytes >= dbBytes * 2);

	const submit = (what: 'prune' | 'compact') => () => {
		sending = what;
		compactError = null;
		return async ({
			result,
			update
		}: {
			result: { type: string; data?: Record<string, unknown> };
			update: () => Promise<void>;
		}) => {
			if (result.type === 'failure') compactError = String(result.data?.compactError ?? 'Not started.');
			await update();
			sending = null;
		};
	};
</script>

{#snippet outcome(t: TaskState)}
	{#if t.running}
		<Tag kind="acc">Running</Tag>
		<span class="t-muted">since {formatDateTime(t.startedAt ?? 0, timeZone)}</span>
	{:else if t.error}
		<Tag kind="error">Failed</Tag> {t.error}
	{:else if t.result && t.finishedAt}
		<Tag kind="success">Done</Tag>
		{t.result}
		<span class="t-muted">({formatDateTime(t.finishedAt, timeZone)})</span>
	{/if}
{/snippet}

<div class="tools">
	<div class="fp-panel tool">
		<h4 class="t-title-3">Prune now</h4>
		<p class="t-ui t-muted">
			Deletes probe results and metrics older than {retentionDays ?? '?'} days now instead of at the next hourly
			clean-up. The space is reused for new rows; the file keeps its size.
		</p>
		<form method="POST" action="?/prune" use:enhance={submit('prune')} class="tool__do">
			<button class="fp-btn" disabled={jobs.prune.running || jobs.compact.running || sending !== null}>
				{jobs.prune.running ? 'Pruning…' : 'Prune now'}
			</button>
			<span class="t-ui out" aria-live="polite">{@render outcome(jobs.prune)}</span>
		</form>
	</div>

	<div class="fp-panel tool">
		<h4 class="t-title-3">Compact the database</h4>
		<p class="t-ui t-muted">
			Rewrites the file without its free pages ({formatBytes(freeInFileBytes)} now), so it shrinks on disk. It needs
			about twice the database’s size free ({formatBytes(dbBytes * 2)}). Probes pause while it runs, which on
			a large database takes minutes.
		</p>
		<form method="POST" action="?/compact" use:enhance={submit('compact')} class="tool__do">
			<button
				class="fp-btn"
				disabled={jobs.compact.running ||
					jobs.prune.running ||
					jobs.backupRunning ||
					sending !== null ||
					!roomToCompact}
			>
				{jobs.compact.running ? 'Compacting…' : 'Compact'}
			</button>
			<span class="t-ui out" aria-live="polite">
				{#if !roomToCompact}<span class="t-muted">Not enough free space on the volume.</span>{/if}
				{@render outcome(jobs.compact)}
			</span>
		</form>
		{#if compactError}<Notice kind="error">{compactError}</Notice>{/if}
	</div>

	<div class="fp-panel tool">
		<h4 class="t-title-3">Download a backup</h4>
		<p class="t-ui t-muted">
			A .tar.gz with a copy of the database (compacted, made while everything keeps running) and the
			Caddyfile. It has the Caddyfile history and saved settings but none of the environment’s secrets. Keep
			it private.
		</p>
		<div class="tool__do">
			{#if jobs.compact.running}
				<button class="fp-btn" disabled>Download backup</button>
				<span class="t-ui t-muted">Wait until compacting is done.</span>
			{:else}
				<a class="fp-btn" href="/api/settings/backup" download data-sveltekit-reload>Download backup</a>
			{/if}
		</div>
	</div>
</div>

<style>
	.tools {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
		gap: var(--space-4);
	}
	.tool {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.tool p {
		margin: 0;
		flex: 1;
	}
	.tool__do {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.out {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
