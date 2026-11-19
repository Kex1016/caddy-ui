<script lang="ts">
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Dialog, Notice, Tag } from '$lib/design/components';
	import DiffView from '$lib/editor/DiffView.svelte';
	import { applyText } from '$lib/editor/api';
	import type { HelperId, HelperProposal } from '../types';

	/**
	 * Caddy helpers (docs/settings-and-perf-plan.md §3): one-click edits to the Caddyfile for metrics per host and
	 * the JSON access log. The page's `?/helper` action works out the change on the file as it is now; this shows
	 * it as a diff, and "Apply and reload Caddy" sends it through the editor's `PUT /api/caddyfile`, so Caddy
	 * validates it first, a conflict with an edit made meanwhile is refused, and the old file stays in History.
	 */
	type Props = {
		metrics: { read: boolean; perHost: boolean; error: string | null };
		accessLog: { path: string; found: boolean; lastEntry: number | null };
	};
	let { metrics, accessLog }: Props = $props();

	let proposal = $state<HelperProposal | null>(null);
	let open = $state(false);
	let busy = $state<HelperId | 'apply' | null>(null);
	let error = $state<string | null>(null);
	let applied = $state<string | null>(null);

	const METRICS_LINE = 'metrics { per_host }';
	const TITLE: Record<HelperId, string> = {
		metrics: 'Turn on metrics per host',
		'access-log': 'Turn on the JSON access log'
	};

	async function review(helper: HelperId) {
		busy = helper;
		error = null;
		applied = null;
		const body = new FormData();
		body.set('helper', helper);
		try {
			const res = await fetch('?/helper', {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const result = deserialize(await res.text());
			if (result.type === 'success' && result.data?.proposal) {
				proposal = result.data.proposal as HelperProposal;
				open = true;
			} else if (result.type === 'failure') {
				error = String(result.data?.helperError ?? 'The change could not be worked out.');
			} else error = 'The change could not be worked out. Reload the page and try again.';
		} catch {
			error = 'This UI could not be reached.';
		}
		busy = null;
	}

	let applyError = $state<string | null>(null);
	async function apply() {
		if (!proposal) return;
		busy = 'apply';
		applyError = null;
		const r = await applyText(
			proposal.after,
			proposal.baseHash,
			`Settings: ${TITLE[proposal.helper].toLowerCase()}`
		);
		busy = null;
		if (r.kind === 'applied') {
			applied = `${TITLE[proposal.helper]}: applied, and Caddy reloaded. The previous file is in History.`;
			open = false;
			proposal = null;
			await invalidateAll();
		} else if (r.kind === 'conflict') {
			applyError = 'The Caddyfile changed since this was worked out. Close this and review the change again.';
		} else if (r.kind === 'refused') {
			applyError = `Caddy refused the change: ${r.message}`;
		} else if (r.kind === 'signed_out') {
			applyError = 'Your session ended. Sign in again in another tab, then apply.';
		} else applyError = r.message;
	}

	const unchanged = $derived(proposal !== null && proposal.before === proposal.after);
</script>

<div class="helpers">
	<div class="fp-panel helper" data-helper="metrics">
		<div class="helper__head">
			<h3 class="t-title-3">Metrics per host</h3>
			{#if metrics.perHost}<Tag kind="success">On, per host</Tag>
			{:else if metrics.read}<Tag kind="warning">On, not per host</Tag>
			{:else if metrics.error}<Tag kind="warning">Not read</Tag>
			{:else}<Tag>Not read yet</Tag>{/if}
		</div>
		<p class="t-ui t-muted">
			Adds <code>{METRICS_LINE}</code> to the global options, so Overview and each site get request counts, status
			codes and latency from Caddy.
		</p>
		<div class="helper__do">
			<button type="button" class="fp-btn" onclick={() => review('metrics')} disabled={busy !== null}>
				{busy === 'metrics' ? 'Working it out…' : 'Review the change'}
			</button>
		</div>
	</div>

	<div class="fp-panel helper" data-helper="access-log">
		<div class="helper__head">
			<h3 class="t-title-3">JSON access log</h3>
			{#if accessLog.found && accessLog.lastEntry}<Tag kind="success">Being read</Tag>
			{:else if accessLog.found}<Tag kind="warning">Found, no entries yet</Tag>
			{:else}<Tag kind="warning">Not found</Tag>{/if}
		</div>
		<p class="t-ui t-muted">
			Has every site write Caddy’s JSON access log to <code>{accessLog.path}</code>, the file this UI reads
			for status codes, top paths and per-minute traffic.
		</p>
		<div class="helper__do">
			<button type="button" class="fp-btn" onclick={() => review('access-log')} disabled={busy !== null}>
				{busy === 'access-log' ? 'Working it out…' : 'Review the change'}
			</button>
		</div>
	</div>
</div>
<div aria-live="polite">
	{#if applied}<Notice kind="success">{applied}</Notice>{/if}
	{#if error}<Notice kind="error">{error}</Notice>{/if}
</div>

<Dialog
	bind:open
	title={proposal ? TITLE[proposal.helper] : 'Caddy helper'}
	onclose={() => (applyError = null)}
>
	{#if proposal}
		<div class="review">
			<p class="t-body">{proposal.summary}</p>
			{#if !unchanged}
				<DiffView before={proposal.before} after={proposal.after} label="Changes to the Caddyfile" />
			{/if}
			{#each proposal.notes as note, i (i)}<p class="t-ui t-muted">{note}</p>{/each}
			{#if applyError}<Notice kind="error">{applyError}</Notice>{/if}
			<div class="review__foot">
				<button type="button" class="fp-btn" onclick={() => (open = false)}>
					{unchanged ? 'Close' : 'Cancel'}
				</button>
				{#if !unchanged}
					<button type="button" class="fp-btn fp-btn--primary" onclick={apply} disabled={busy === 'apply'}>
						{busy === 'apply' ? 'Applying…' : 'Apply and reload Caddy'}
					</button>
				{/if}
			</div>
		</div>
	{/if}
</Dialog>

<style>
	.helpers {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr));
		gap: var(--space-4);
	}
	.helper {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.helper p {
		margin: 0;
		flex: 1;
	}
	.helper__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.helper__do {
		display: flex;
		gap: var(--space-2);
	}
	.review {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: min(44rem, 80vw);
	}
	.review p {
		margin: 0;
	}
	.review__foot {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
