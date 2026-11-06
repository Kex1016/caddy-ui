<script lang="ts">
	import { ChevronDown, Plus, X } from '@lucide/svelte';
	import type { Directive } from '@caddy-ui/caddyfile';
	import type { FormContext, RowsField } from '../../forms/types';
	import PlaceholderPicker from './PlaceholderPicker.svelte';

	type Props = { field: RowsField; node: Directive; ctx: FormContext; commit: () => void };
	let { field, node, ctx, commit }: Props = $props();

	const rows = $derived(field.get(node));
	const columns = $derived(field.columnsFor?.(node) ?? field.columns);
	const id = `fld-${Math.random().toString(36).slice(2, 8)}`;

	/**
	 * Rows are written to the file only once every required column has a value, so "Add" shows an empty
	 * row to fill in (instead of writing a line with no arguments), and clearing a cell to retype it does
	 * not delete the line and the comments above it. Until then the row lives here.
	 */
	let drafts = $state<string[][]>([]);
	let pending = $state<Record<number, string[]>>({});
	const shown = $derived([...rows.map((row, i) => pending[i] ?? row), ...drafts]);
	const ready = (row: readonly string[]) => columns.every((col, i) => col.optional || (row[i] ?? '') !== '');

	function set(next: string[][]) {
		field.set(node, next);
		commit();
	}
	function cell(r: number, c: number, v: string) {
		const row = [...(shown[r] ?? [])];
		while (row.length <= c) row.push('');
		row[c] = v;
		if (r < rows.length) {
			if (!ready(row)) {
				pending = { ...pending, [r]: row };
				return;
			}
			pending = Object.fromEntries(Object.entries(pending).filter(([k]) => Number(k) !== r));
			set(rows.map((x, i) => (i === r ? row : [...x])));
			return;
		}
		const d = r - rows.length;
		if (!ready(row)) {
			drafts = drafts.map((x, i) => (i === d ? row : x));
			return;
		}
		drafts = drafts.filter((_, i) => i !== d);
		set([...rows.map((x) => [...x]), row]);
	}
	function add() {
		drafts = [...drafts, columns.map(() => '')];
	}
	function remove(r: number) {
		if (r >= rows.length) {
			drafts = drafts.filter((_, i) => i !== r - rows.length);
			return;
		}
		pending = {};
		set(rows.filter((_, i) => i !== r));
	}
</script>

<div class="rws">
	<p class="t-ui rws__label" id="{id}-label">{field.label}</p>
	{#if shown.length}
		<div class="rws__table" role="table" aria-labelledby="{id}-label" style="--cols: {columns.length}">
			<div class="rws__head" role="row">
				{#each columns as col (col.id)}
					<span class="t-kicker rws__th" role="columnheader"
						>{col.label}{#if col.optional}<span class="t-faint"> ?</span>{/if}</span
					>
				{/each}
				<span class="rws__th" aria-hidden="true"></span>
			</div>
			{#each shown as row, r (r)}
				<div class="rws__row" role="row">
					{#each columns as col, c (col.id)}
						{#if col.options}
							<span class="fp-select rws__sel" role="cell">
								<select
									value={row[c] ?? ''}
									aria-label="{col.label} {r + 1}"
									onchange={(e) => cell(r, c, (e.currentTarget as HTMLSelectElement).value)}
								>
									<option value="">{col.optional ? '—' : 'Pick…'}</option>
									{#each col.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
								</select>
								<ChevronDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
							</span>
						{:else}
							<span class="fp-field rws__cell" role="cell">
								<input
									value={row[c] ?? ''}
									placeholder={col.placeholder ?? (col.prefixes?.length ? `${col.prefixes.join('')}…` : '')}
									spellcheck="false"
									autocomplete="off"
									aria-label="{col.label} {r + 1}"
									oninput={(e) => cell(r, c, (e.currentTarget as HTMLInputElement).value)}
								/>
								{#if ctx.placeholders.length && c > 0}
									<PlaceholderPicker
										choices={ctx.placeholders}
										oninsert={(n) => cell(r, c, (row[c] ?? '') + n)}
									/>
								{/if}
							</span>
						{/if}
					{/each}
					<button
						class="fp-ibtn rws__x"
						type="button"
						aria-label="Remove row {r + 1}"
						onclick={() => remove(r)}
					>
						<X class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
					</button>
				</div>
			{/each}
		</div>
	{/if}
	<div>
		<button class="fp-btn fp-btn--quiet rws__add" type="button" onclick={add}>
			<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
			{field.addLabel ?? 'Add row'}
		</button>
	</div>
	{#if field.help}<p class="t-caption rws__hint">{field.help}</p>{/if}
</div>

<style>
	.rws {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.rws__label {
		font-weight: 500;
	}
	.rws__table {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		overflow-x: auto;
	}
	.rws__head,
	.rws__row {
		display: grid;
		grid-template-columns: repeat(var(--cols, 3), minmax(7rem, 1fr)) 32px;
		gap: var(--space-1);
		align-items: center;
	}
	.rws__th {
		font-size: 10px;
		padding-left: var(--space-2);
	}
	.rws__cell input {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.rws__cell,
	.rws__sel {
		min-width: 0;
	}
	.rws__sel select {
		width: 100%;
	}
	.rws__add {
		padding-left: var(--space-2);
	}
	.rws__hint {
		color: var(--muted);
	}
</style>
