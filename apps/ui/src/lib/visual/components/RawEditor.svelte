<script lang="ts">
	import { Notice } from '$lib/design/components';

	type Props = {
		/** The text to start from. */
		text: string;
		label?: string;
		placeholder?: string;
		/** Called with the new text; return an error message to keep the editor open with it. */
		onapply: (text: string) => string | void;
		oncancel?: () => void;
		applyLabel?: string;
		rows?: number;
	};
	let {
		text,
		label = 'Caddyfile lines',
		placeholder,
		onapply,
		oncancel,
		applyLabel = 'Apply',
		rows = 6
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	let draft = $state(text);
	let error = $state<string | null>(null);
	$effect(() => {
		draft = text;
		error = null;
	});
	const dirty = $derived(draft !== text);

	function apply() {
		error = onapply(draft) ?? null;
	}
	function onkeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			apply();
		}
	}
</script>

<div class="raw">
	<label class="raw__label">
		<span class="visually-hidden">{label}</span>
		<textarea class="raw__area" bind:value={draft} {rows} {placeholder} spellcheck="false" {onkeydown}
		></textarea>
	</label>
	{#if error}<Notice kind="error">{error}</Notice>{/if}
	<div class="raw__foot">
		<span class="t-caption t-muted">Tab-indented Caddyfile text. Ctrl+Enter applies.</span>
		<span class="raw__btns">
			{#if oncancel}<button class="fp-btn fp-btn--quiet" type="button" onclick={oncancel}>Cancel</button>{/if}
			<button class="fp-btn" type="button" onclick={apply} disabled={!dirty && text !== ''}
				>{applyLabel}</button
			>
		</span>
	</div>
</div>

<style>
	.raw {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.raw__label {
		display: block;
	}
	.raw__area {
		width: 100%;
		box-sizing: border-box;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sunk);
		color: var(--text);
		font: 400 13px/20px var(--font-mono);
		resize: vertical;
		tab-size: 4;
	}
	.raw__area:focus-visible {
		border-color: var(--acc-ink);
		box-shadow: var(--focus-ring);
	}
	.raw__foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.raw__btns {
		display: inline-flex;
		gap: var(--space-2);
	}
</style>
