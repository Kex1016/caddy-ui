<script lang="ts">
	import { Plus, X } from '@lucide/svelte';
	import type { Directive } from '@caddy-ui/caddyfile';
	import { checkValue } from '@caddy-ui/caddy-schema/grammars';
	import type { FormContext, ListField } from '../../forms/types';
	import PlaceholderPicker from './PlaceholderPicker.svelte';

	type Props = { field: ListField; node: Directive; ctx: FormContext; commit: () => void };
	let { field, node, ctx, commit }: Props = $props();

	const values = $derived(field.get(node));
	const id = `fld-${Math.random().toString(36).slice(2, 8)}`;
	let draft = $state('');
	let input: HTMLInputElement | undefined = $state();

	function set(next: string[]) {
		field.set(node, next);
		commit();
	}

	function add() {
		const parts = draft
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (!parts.length) return;
		set([...values, ...parts]);
		draft = '';
	}

	function remove(i: number) {
		set(values.filter((_, k) => k !== i));
	}

	function edit(i: number, v: string) {
		const next = [...values];
		next[i] = v;
		set(next);
	}

	function onkey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			add();
		} else if (e.key === 'Backspace' && draft === '' && values.length) {
			remove(values.length - 1);
		}
	}

	const problem = (v: string) =>
		field.type === 'enum' || field.type === 'matcher'
			? null
			: checkValue(field.type, v, { literals: field.literals ? [...field.literals] : undefined });

	function toggleChoice(value: string, on: boolean) {
		const next = values.filter((v) => v !== value);
		if (on) {
			// keep the choices' own order
			const order = field.choices!.map((c) => c.value);
			next.push(value);
			next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
		}
		set(next);
	}
</script>

<div class="lst">
	<p class="t-ui lst__label" id="{id}-label">{field.label}</p>
	{#if field.choices}
		<div class="lst__choices" role="group" aria-labelledby="{id}-label">
			{#each field.choices as c (c.value)}
				<label class="lst__choice t-ui">
					<input
						type="checkbox"
						checked={values.includes(c.value)}
						onchange={(e) => toggleChoice(c.value, (e.currentTarget as HTMLInputElement).checked)}
					/>
					{c.label}
				</label>
			{/each}
		</div>
	{:else}
		<div class="lst__items" role="list" aria-labelledby="{id}-label">
			{#each values as v, i (i)}
				<div class="lst__item" role="listitem" class:lst__item--bad={problem(v)}>
					<input
						class="lst__edit t-mono"
						value={v}
						size={Math.max(4, v.length + 1)}
						spellcheck="false"
						aria-label="{field.label} {i + 1}"
						oninput={(e) => edit(i, (e.currentTarget as HTMLInputElement).value)}
					/>
					<button class="lst__x" type="button" aria-label="Remove {v}" onclick={() => remove(i)}>
						<X class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
					</button>
				</div>
			{/each}
		</div>
		<div class="lst__add">
			<span class="fp-field lst__field">
				<input
					bind:this={input}
					bind:value={draft}
					placeholder={field.placeholder ?? 'Add…'}
					spellcheck="false"
					autocomplete="off"
					aria-label="Add to {field.label}"
					list={field.literals?.length ? `${id}-lit` : undefined}
					onkeydown={onkey}
					onblur={add}
				/>
				{#if field.literals?.length}
					<datalist id="{id}-lit"
						>{#each field.literals as l (l)}<option value={l}></option>{/each}</datalist
					>
				{/if}
			</span>
			<button class="fp-ibtn" type="button" aria-label="Add" title="Add" onclick={add}>
				<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
			</button>
			{#if ctx.placeholders.length && field.type !== 'upstream'}
				<PlaceholderPicker choices={ctx.placeholders} oninsert={(n) => (draft += n)} />
			{/if}
		</div>
	{/if}
	{#if field.help}<p class="t-caption lst__hint">{field.help}</p>{/if}
</div>

<style>
	.lst {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.lst__label {
		font-weight: 500;
	}
	.lst__items {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}
	.lst__item {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 0 2px 0 var(--space-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--surface);
		height: 28px;
	}
	.lst__item--bad {
		border-color: var(--error-ink);
	}
	.lst__edit {
		border: 0;
		background: transparent;
		outline: 0;
		font-size: 13px;
		min-width: 3ch;
		max-width: 40ch;
		color: var(--text);
	}
	.lst__x {
		display: inline-flex;
		border: 0;
		background: transparent;
		padding: 2px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	.lst__x:hover {
		background: var(--raised);
	}
	.lst__add {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	.lst__field {
		flex: 1;
		min-width: 0;
	}
	.lst__field input {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.lst__choices {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
	}
	.lst__choice {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		cursor: pointer;
	}
	.lst__hint {
		color: var(--muted);
	}
</style>
