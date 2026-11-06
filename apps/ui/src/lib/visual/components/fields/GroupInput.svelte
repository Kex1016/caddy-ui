<script lang="ts">
	import { ChevronDown, ChevronRight, Plus, Trash2 } from '@lucide/svelte';
	import type { Directive } from '@caddy-ui/caddyfile';
	import type { FormContext, GroupField } from '../../forms/types';
	import FormRenderer from '../FormRenderer.svelte';

	type Props = { field: GroupField; node: Directive; ctx: FormContext; commit: () => void };
	let { field, node, ctx, commit }: Props = $props();

	const sub = $derived(field.get(node));
	// svelte-ignore state_referenced_locally
	let open = $state(!field.collapsed);

	function create() {
		field.create(node);
		open = true;
		commit();
	}
	function remove() {
		field.remove(node);
		commit();
	}
</script>

<div class="grp" class:grp--on={sub}>
	<div class="grp__head">
		{#if sub}
			<button class="grp__toggle" type="button" aria-expanded={open} onclick={() => (open = !open)}>
				{#if open}<ChevronDown
						class="fp-ico fp-ico--sm"
						strokeWidth={1.4}
						aria-hidden="true"
					/>{:else}<ChevronRight class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />{/if}
				<span class="t-ui grp__label">{field.label}</span>
			</button>
			<button class="fp-ibtn" type="button" aria-label="Remove {field.label}" title="Remove" onclick={remove}>
				<Trash2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
			</button>
		{:else}
			<span class="t-ui grp__label grp__label--off">{field.label}</span>
			<button class="fp-btn fp-btn--quiet" type="button" onclick={create}>
				<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Set up
			</button>
		{/if}
	</div>
	{#if field.help && (!sub || !open)}<p class="t-caption grp__hint">{field.help}</p>{/if}
	{#if sub && open}
		<div class="grp__body">
			<FormRenderer fields={field.fields} node={sub} {ctx} {commit} />
		</div>
	{/if}
</div>

<style>
	.grp {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-lg);
		padding: var(--space-2) var(--space-3);
	}
	.grp--on {
		background: var(--sunk);
	}
	.grp__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.grp__toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		border: 0;
		background: transparent;
		padding: 0;
		cursor: pointer;
		color: var(--text);
	}
	.grp__label {
		font-weight: 500;
	}
	.grp__label--off {
		color: var(--muted);
	}
	.grp__hint {
		color: var(--muted);
	}
	.grp__body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-2) 0 var(--space-2) var(--space-5);
	}
</style>
