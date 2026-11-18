<script lang="ts">
	import type { Snippet } from 'svelte';
	import { writeBlock, type PorkbunScope, type PorkbunStatus } from '$lib/api/porkbun';

	/**
	 * Wraps a control that changes something at Porkbun. When the change is not allowed (read-only mode, or the
	 * key lacks the scope) the control is still drawn, disabled, with the reason beside it: controls are never
	 * hidden (docs/porkbun-plan.md §3.1 rule 8). The snippet gets `disabled` and `reason` to put on the control.
	 *
	 *     <ScopeGate status={data.porkbun} scope="dns">
	 *         {#snippet children({ disabled })}<button class="fp-btn" {disabled}>Add record</button>{/snippet}
	 *     </ScopeGate>
	 */
	type Props = {
		status: Pick<PorkbunStatus, 'state' | 'readonly' | 'scopes'>;
		scope: PorkbunScope;
		/** Set to false where the reason is already shown once for a group of controls. */
		showReason?: boolean;
		children: Snippet<[{ disabled: boolean; reason: string | null }]>;
	};
	let { status, scope, showReason = true, children }: Props = $props();

	const block = $derived(writeBlock(status, scope));
</script>

<span class="gate" title={block?.message}>
	{@render children({ disabled: block !== null, reason: block?.message ?? null })}
	{#if block && showReason}<span class="t-caption gate__why">{block.message}</span>{/if}
</span>

<style>
	.gate {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}
	.gate__why {
		max-width: 420px;
	}
</style>
