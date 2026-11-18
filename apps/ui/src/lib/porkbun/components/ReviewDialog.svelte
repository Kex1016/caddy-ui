<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ApiError, DryRun } from '$lib/api/porkbun';
	import { Dialog, Notice } from '$lib/design/components';
	import type { ReviewChange } from '$lib/porkbun/types';
	import PorkbunNotice from './PorkbunNotice.svelte';
	import TypedConfirm from './TypedConfirm.svelte';

	/**
	 * The review step every write goes through (docs/porkbun-plan.md §3.1): what will change, before and after;
	 * the result of Porkbun's dry run where there is one; a typed confirmation where the action is destructive;
	 * and only then the button that sends it. Nothing is sent by opening the dialog.
	 *
	 * The page owns the requests. It opens the dialog, runs the dry run and passes the result in `dryRun`
	 * ('running' while waiting, null when the action has no dry run), and does the write in `onapply`.
	 */
	type Props = {
		open: boolean;
		title: string;
		/** One sentence on what applying does. */
		intro?: string;
		changes?: readonly ReviewChange[];
		/** Porkbun's rehearsal: 'running', its result, or null when the action has none. */
		dryRun?: DryRun | 'running' | null;
		/** Extra warnings to show as written (preflight findings, sites that depend on a record). */
		warnings?: readonly string[];
		/** A reason the change can not be applied at all (a preflight blocker). Disables Apply. */
		blocked?: string | null;
		/** Set to the domain name to require typing it. */
		confirmText?: string | null;
		confirmPurpose?: string;
		/** Draws the Apply button in the error colours. */
		destructive?: boolean;
		applyLabel?: string;
		busy?: boolean;
		/** The failure of the last attempt to apply. */
		error?: ApiError | null;
		onapply: () => void;
		oncancel?: () => void;
		/** More detail under the list of changes. */
		children?: Snippet;
	};
	let {
		open = $bindable(),
		title,
		intro,
		changes = [],
		dryRun = null,
		warnings = [],
		blocked = null,
		confirmText = null,
		confirmPurpose,
		destructive = false,
		applyLabel = 'Apply',
		busy = false,
		error = null,
		onapply,
		oncancel,
		children
	}: Props = $props();

	let typed = $state(false);
	const rehearsal = $derived(dryRun !== null && dryRun !== 'running' ? dryRun : null);
	const ready = $derived(
		!busy &&
			!blocked &&
			dryRun !== 'running' &&
			(rehearsal === null || rehearsal.wouldSucceed) &&
			(!confirmText || typed)
	);
	const VERB = { create: 'Add', edit: 'Change', delete: 'Delete' } as const;

	function cancel() {
		open = false;
	}
</script>

<Dialog bind:open {title} onclose={() => oncancel?.()}>
	<div class="review">
		{#if intro}<p class="t-body t-muted">{intro}</p>{/if}

		{#if changes.length > 0}
			<ul class="review__list" aria-label="Changes">
				{#each changes as change, i (i)}
					<li class="review__item">
						<p class="review__title">
							<span
								class="fp-tag"
								class:fp-tag--error={change.kind === 'delete'}
								class:fp-tag--acc={change.kind !== 'delete'}>{VERB[change.kind]}</span
							>
							<span class="t-mono review__what">{change.title}</span>
						</p>
						{#if change.before != null}
							<p class="review__value">
								<span class="t-caption">Before</span> <del class="t-mono">{change.before}</del>
							</p>
						{/if}
						{#if change.after != null}
							<p class="review__value">
								<span class="t-caption">After</span> <ins class="t-mono">{change.after}</ins>
							</p>
						{/if}
						{#if change.note}<p class="t-ui t-muted">{change.note}</p>{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{@render children?.()}

		{#if blocked}
			<Notice kind="error"><b>This can not be applied.</b> {blocked}</Notice>
		{/if}
		{#if dryRun === 'running'}
			<p class="t-ui t-muted" role="status">Asking Porkbun to check this without changing anything…</p>
		{:else if rehearsal?.wouldSucceed}
			<Notice kind="success"
				>Porkbun checked this change and would accept it. Nothing has been changed yet.</Notice
			>
		{:else if rehearsal}
			<Notice kind="error"><b>Porkbun would refuse this change.</b> Nothing has been changed.</Notice>
			<PorkbunNotice error={rehearsal.error} />
		{/if}
		<PorkbunNotice warnings={[...(rehearsal?.warnings ?? []), ...warnings]} />

		{#if confirmText}
			<TypedConfirm expected={confirmText} bind:matches={typed} purpose={confirmPurpose} />
		{/if}

		{#if error}
			<PorkbunNotice {error} />
		{/if}

		<div class="review__actions">
			<button type="button" class="fp-btn" onclick={cancel}>Cancel</button>
			<button
				type="button"
				class="fp-btn"
				class:fp-btn--primary={!destructive}
				class:review__danger={destructive}
				disabled={!ready}
				onclick={onapply}
			>
				{busy ? 'Applying…' : applyLabel}
			</button>
		</div>
	</div>
</Dialog>

<style>
	.review {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.review__list {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 40vh;
		overflow-y: auto;
	}
	.review__item {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-lg);
		background: var(--sunk);
	}
	.review__title {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
	.review__what,
	.review__value {
		font-size: 13px;
		line-height: 20px;
		overflow-wrap: anywhere;
	}
	.review__value del {
		color: var(--error-ink);
	}
	.review__value ins {
		color: var(--success-ink);
		text-decoration: none;
	}
	.review__actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-3);
	}
	.review__danger {
		background: var(--error);
		border-color: var(--error);
		color: var(--on-acc);
	}
	.review__danger:hover {
		background: color-mix(in srgb, var(--error), var(--on-acc) 9%);
		border-color: transparent;
	}
</style>
