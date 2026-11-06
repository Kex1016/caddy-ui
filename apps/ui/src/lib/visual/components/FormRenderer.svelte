<script lang="ts">
	import { ChevronDown, ChevronRight } from '@lucide/svelte';
	import type { Directive } from '@caddy-ui/caddyfile';
	import { Notice } from '$lib/design/components';
	import type { FieldSpec, FormContext } from '../forms/types';
	import GroupInput from './fields/GroupInput.svelte';
	import ListInput from './fields/ListInput.svelte';
	import RowsInput from './fields/RowsInput.svelte';
	import SelectInput from './fields/SelectInput.svelte';
	import TextInput from './fields/TextInput.svelte';
	import ToggleInput from './fields/ToggleInput.svelte';
	import VariantInput from './fields/VariantInput.svelte';
	import FormRendererSelf from './FormRenderer.svelte';

	type Props = { fields: readonly FieldSpec[]; node: Directive; ctx: FormContext; commit: () => void };
	let { fields, node, ctx, commit }: Props = $props();

	const shown = $derived(fields.filter((f) => !('when' in f && f.when) || f.when(node, ctx)));
	let openSections = $state<Record<string, boolean>>({});
	const isOpen = (id: string, collapsed: boolean | undefined) => openSections[id] ?? !collapsed;
</script>

{#each shown as field (field.id)}
	{#if field.kind === 'text'}
		<TextInput {field} {node} {ctx} {commit} />
	{:else if field.kind === 'select'}
		<SelectInput {field} {node} {commit} />
	{:else if field.kind === 'toggle'}
		<ToggleInput {field} {node} {commit} />
	{:else if field.kind === 'list'}
		<ListInput {field} {node} {ctx} {commit} />
	{:else if field.kind === 'rows'}
		<RowsInput {field} {node} {ctx} {commit} />
	{:else if field.kind === 'group'}
		<GroupInput {field} {node} {ctx} {commit} />
	{:else if field.kind === 'variant'}
		<VariantInput {field} {node} {ctx} {commit} />
	{:else if field.kind === 'section'}
		<section class="sec">
			<button
				class="sec__head"
				type="button"
				aria-expanded={isOpen(field.id, field.collapsed)}
				onclick={() => (openSections[field.id] = !isOpen(field.id, field.collapsed))}
			>
				{#if isOpen(field.id, field.collapsed)}<ChevronDown
						class="fp-ico fp-ico--sm"
						strokeWidth={1.4}
						aria-hidden="true"
					/>{:else}<ChevronRight class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />{/if}
				<span class="t-title-4 sec__title">{field.title}</span>
				{#if field.help && !isOpen(field.id, field.collapsed)}<span class="t-caption sec__help"
						>{field.help}</span
					>{/if}
			</button>
			{#if isOpen(field.id, field.collapsed)}
				<div class="sec__body">
					{#if field.help}<p class="t-caption sec__lede">{field.help}</p>{/if}
					<FormRendererSelf fields={field.fields} {node} {ctx} {commit} />
				</div>
			{/if}
		</section>
	{:else if field.kind === 'note'}
		<Notice kind={field.tone === 'warning' ? 'warning' : 'info'}>{field.text}</Notice>
	{:else if field.kind === 'custom'}
		<field.component {node} {ctx} {commit} />
	{/if}
{/each}

<style>
	.sec {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding-top: var(--space-2);
		border-top: 1px solid var(--line-soft);
	}
	.sec__head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		border: 0;
		background: transparent;
		padding: var(--space-1) 0;
		cursor: pointer;
		color: var(--text);
		text-align: left;
	}
	.sec__title {
		font-size: 14px;
	}
	.sec__help {
		color: var(--muted);
		margin-left: var(--space-2);
	}
	.sec__lede {
		color: var(--muted);
	}
	.sec__body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding-bottom: var(--space-2);
	}
</style>
