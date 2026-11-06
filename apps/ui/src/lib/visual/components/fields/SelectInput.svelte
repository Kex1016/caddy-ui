<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import type { Directive } from '@caddy-ui/caddyfile';
	import type { SelectField } from '../../forms/types';

	type Props = { field: SelectField; node: Directive; commit: () => void };
	let { field, node, commit }: Props = $props();

	const value = $derived(field.get(node) ?? '');
	const id = `fld-${Math.random().toString(36).slice(2, 8)}`;
	const known = $derived(value === '' || field.options.some((o) => o.value === value));
	const doc = $derived(field.options.find((o) => o.value === value)?.doc);

	function update(v: string) {
		field.set(node, v === '' ? undefined : v);
		commit();
	}
</script>

<div class="fld">
	<label class="fld__label t-ui" for={id}>{field.label}</label>
	<span class="fp-select fld__select">
		<select {id} {value} onchange={(e) => update((e.currentTarget as HTMLSelectElement).value)}>
			{#if field.empty !== undefined}<option value="">{field.empty}</option>{/if}
			{#if !known}<option {value}>{value} (as written)</option>{/if}
			{#each field.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<ChevronDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
	</span>
	{#if doc || field.help}
		<p class="fld__hint t-caption">{doc ?? field.help}</p>
	{/if}
</div>

<style>
	.fld {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.fld__label {
		font-weight: 500;
	}
	.fld__select {
		width: 100%;
	}
	.fld__select select {
		width: 100%;
	}
	.fld__hint {
		color: var(--muted);
	}
</style>
