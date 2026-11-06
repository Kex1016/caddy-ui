<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import type { Directive } from '@caddy-ui/caddyfile';
	import type { FormContext, VariantField } from '../../forms/types';
	import FormRenderer from '../FormRenderer.svelte';

	type Props = { field: VariantField; node: Directive; ctx: FormContext; commit: () => void };
	let { field, node, ctx, commit }: Props = $props();

	const current = $derived(field.get(node));
	const option = $derived(field.options.find((o) => o.value === current?.value));
	const id = `fld-${Math.random().toString(36).slice(2, 8)}`;

	function pick(v: string) {
		field.set(node, v === '' ? undefined : v);
		commit();
	}
</script>

<div class="vr">
	<label class="t-ui vr__label" for={id}>{field.label}</label>
	<span class="fp-select vr__select">
		<select
			{id}
			value={current?.value ?? ''}
			onchange={(e) => pick((e.currentTarget as HTMLSelectElement).value)}
		>
			<option value="">{field.empty ?? 'Not set'}</option>
			{#if current && !option}<option value={current.value}>{current.value} (as written)</option>{/if}
			{#each field.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<ChevronDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
	</span>
	{#if option?.doc || field.help}<p class="t-caption vr__hint">{option?.doc ?? field.help}</p>{/if}
	{#if current && option && option.fields.length}
		<div class="vr__body">
			<FormRenderer fields={option.fields} node={current.node} {ctx} {commit} />
		</div>
	{/if}
</div>

<style>
	.vr {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.vr__label {
		font-weight: 500;
	}
	.vr__select,
	.vr__select select {
		width: 100%;
	}
	.vr__hint {
		color: var(--muted);
	}
	.vr__body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		margin-top: var(--space-2);
		padding: var(--space-3) 0 var(--space-2) var(--space-4);
		border-left: 2px solid var(--line-soft);
	}
</style>
