<script lang="ts">
	import type { Directive } from '@caddy-ui/caddyfile';
	import { checkValue } from '@caddy-ui/caddy-schema/grammars';
	import type { FormContext, TextField } from '../../forms/types';
	import PlaceholderPicker from './PlaceholderPicker.svelte';

	type Props = { field: TextField; node: Directive; ctx: FormContext; commit: () => void };
	let { field, node, ctx, commit }: Props = $props();

	const value = $derived(field.get(node) ?? '');
	const id = `fld-${Math.random().toString(36).slice(2, 8)}`;
	const withPlaceholders = $derived(
		field.placeholders ??
			['string', 'path', 'url', 'header', 'placeholder', 'cel', 'upstream'].includes(field.type)
	);
	const problem = $derived.by(() => {
		if (value === '') return field.required ? 'Required' : null;
		if (field.type === 'enum' || field.type === 'matcher') return null;
		return checkValue(field.type, value, { literals: field.literals ? [...field.literals] : undefined });
	});

	let el: HTMLInputElement | HTMLTextAreaElement | undefined = $state();

	function update(v: string) {
		field.set(node, v === '' ? undefined : v);
		commit();
	}

	function insert(name: string) {
		const input = el;
		if (!input) {
			update(value + name);
			return;
		}
		const start = input.selectionStart ?? value.length;
		const end = input.selectionEnd ?? start;
		const next = value.slice(0, start) + name + value.slice(end);
		update(next);
		requestAnimationFrame(() => {
			input.focus();
			input.setSelectionRange(start + name.length, start + name.length);
		});
	}
</script>

<div class="fld">
	<label class="fld__label t-ui" for={id}
		>{field.label}{#if field.required}<span class="fld__req" aria-hidden="true"> *</span>{/if}</label
	>
	<div class="fld__row">
		{#if field.multiline}
			<textarea
				{id}
				class="fld__area t-mono"
				rows="3"
				bind:this={el}
				{value}
				placeholder={field.placeholder}
				spellcheck="false"
				oninput={(e) => update((e.currentTarget as HTMLTextAreaElement).value)}
			></textarea>
		{:else}
			<span class="fp-field fld__field" class:fld__field--bad={problem && value !== ''}>
				<input
					{id}
					bind:this={el}
					{value}
					placeholder={field.placeholder}
					spellcheck="false"
					autocomplete="off"
					list={field.literals?.length ? `${id}-lit` : undefined}
					oninput={(e) => update((e.currentTarget as HTMLInputElement).value)}
				/>
				{#if field.literals?.length}
					<datalist id="{id}-lit">
						{#each field.literals as l (l)}<option value={l}></option>{/each}
					</datalist>
				{/if}
			</span>
		{/if}
		{#if withPlaceholders && ctx.placeholders.length}
			<PlaceholderPicker choices={ctx.placeholders} oninsert={insert} />
		{/if}
	</div>
	{#if problem && value !== ''}
		<p class="fld__hint fld__hint--bad t-caption">{problem}</p>
	{:else if field.help}
		<p class="fld__hint t-caption">{field.help}</p>
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
		color: var(--text);
		font-weight: 500;
	}
	.fld__req {
		color: var(--faint);
	}
	.fld__row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.fld__field {
		flex: 1;
		min-width: 0;
	}
	.fld__field input {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.fld__field--bad {
		border-color: var(--error-ink);
	}
	.fld__area {
		flex: 1;
		min-width: 0;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sunk);
		color: var(--text);
		font-size: 13px;
		line-height: 20px;
		resize: vertical;
	}
	.fld__area:focus-visible {
		border-color: var(--acc-ink);
		box-shadow: var(--focus-ring);
	}
	.fld__hint {
		color: var(--muted);
	}
	.fld__hint--bad {
		color: var(--error-ink);
	}
</style>
