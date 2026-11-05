<script lang="ts">
	import { X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	type Props = { open: boolean; title: string; children: Snippet; onclose?: () => void };
	let { open = $bindable(), title, children, onclose }: Props = $props();
	let el: HTMLDialogElement | undefined = $state();
	const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;

	$effect(() => {
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});
</script>

<dialog
	bind:this={el}
	class="dlg"
	aria-labelledby={titleId}
	onclose={() => {
		open = false;
		onclose?.();
	}}
	onclick={(e) => {
		if (e.target === el) el?.close();
	}}
>
	<div class="dlg__in">
		<header class="dlg__head">
			<h2 class="t-title-2" id={titleId}>{title}</h2>
			<button class="fp-ibtn" type="button" aria-label="Close" onclick={() => el?.close()}>
				<X class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
			</button>
		</header>
		{#if open}{@render children()}{/if}
	</div>
</dialog>

<style>
	.dlg {
		margin: auto;
		width: min(480px, calc(100vw - var(--space-8)));
		padding: 0;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius-2xl);
		box-shadow: var(--shadow-modal);
	}
	.dlg::backdrop {
		background: color-mix(in srgb, var(--bg), transparent 30%);
	}
	.dlg__in {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-5);
	}
	.dlg__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
</style>
