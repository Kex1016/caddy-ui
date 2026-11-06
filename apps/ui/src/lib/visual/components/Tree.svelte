<script lang="ts">
	import {
		AtSign,
		ChevronDown,
		ChevronRight,
		Code,
		Dot,
		FileInput,
		Globe,
		Parentheses,
		Route,
		Settings2
	} from '@lucide/svelte';
	import type { Component } from 'svelte';
	import { parentPath, pathKey } from '../document';
	import type { RowKind, TreeRow } from '../tree';

	type Props = {
		rows: TreeRow[];
		selected: string | null;
		label?: string;
		onselect: (key: string) => void;
		ontoggle: (key: string, expanded: boolean) => void;
		onmove?: (from: TreeRow, to: TreeRow, where: 'before' | 'after') => void;
		ondelete?: (key: string) => void;
		onduplicate?: (key: string) => void;
	};
	let {
		rows,
		selected,
		label = 'Caddyfile outline',
		onselect,
		ontoggle,
		onmove,
		ondelete,
		onduplicate
	}: Props = $props();

	const ICONS: Record<RowKind, Component> = {
		global: Settings2,
		snippet: Parentheses,
		named_route: Route,
		site: Globe,
		import: FileInput,
		directive: Dot,
		matcher: AtSign,
		raw: Code
	};

	let els = $state<Record<string, HTMLElement | undefined>>({});
	let focusKey = $state<string | null>(null);
	let dragKey = $state<string | null>(null);
	let drop = $state<{ key: string; where: 'before' | 'after' } | null>(null);

	const parentKeyOf = (r: TreeRow) => (r.path.nodes.length ? pathKey(parentPath(r.path)) : 'file');
	const indexOf = (key: string) => rows.findIndex((r) => r.key === key);

	function focusRow(key: string) {
		focusKey = key;
		onselect(key);
		requestAnimationFrame(() => els[key]?.focus());
	}

	function onkeydown(e: KeyboardEvent) {
		const key = focusKey ?? selected;
		const i = key ? indexOf(key) : -1;
		const row = i >= 0 ? rows[i] : undefined;
		switch (e.key) {
			case 'ArrowDown':
				if (i < rows.length - 1) focusRow(rows[i + 1]!.key);
				break;
			case 'ArrowUp':
				if (i > 0) focusRow(rows[i - 1]!.key);
				break;
			case 'Home':
				if (rows.length) focusRow(rows[0]!.key);
				break;
			case 'End':
				if (rows.length) focusRow(rows[rows.length - 1]!.key);
				break;
			case 'ArrowRight':
				if (!row) return;
				if (row.hasChildren && !row.expanded) ontoggle(row.key, true);
				else if (row.hasChildren && i < rows.length - 1) focusRow(rows[i + 1]!.key);
				break;
			case 'ArrowLeft': {
				if (!row) return;
				if (row.hasChildren && row.expanded) ontoggle(row.key, false);
				else if (row.path.nodes.length) focusRow(parentKeyOf(row));
				break;
			}
			case 'Enter':
			case ' ':
				if (row) onselect(row.key);
				break;
			case 'Delete':
			case 'Backspace':
				if (row && ondelete) ondelete(row.key);
				break;
			case 'd':
			case 'D':
				if (row && onduplicate && (e.ctrlKey || e.metaKey)) onduplicate(row.key);
				else return;
				break;
			default:
				return;
		}
		e.preventDefault();
	}

	function dragstart(e: DragEvent, row: TreeRow) {
		if (!onmove) return;
		dragKey = row.key;
		e.dataTransfer?.setData('text/plain', row.key);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	function dragover(e: DragEvent, row: TreeRow) {
		if (!dragKey || dragKey === row.key) return;
		const from = rows[indexOf(dragKey)];
		if (!from || parentKeyOf(from) !== parentKeyOf(row)) return;
		e.preventDefault();
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		drop = { key: row.key, where: e.clientY - rect.top < rect.height / 2 ? 'before' : 'after' };
	}
	function dropOn(e: DragEvent, row: TreeRow) {
		e.preventDefault();
		const from = dragKey ? rows[indexOf(dragKey)] : undefined;
		if (from && drop && drop.key === row.key && onmove) onmove(from, row, drop.where);
		dragKey = null;
		drop = null;
	}
	function dragend() {
		dragKey = null;
		drop = null;
	}
</script>

<ul class="tree" role="tree" aria-label={label} {onkeydown}>
	{#each rows as row (row.key)}
		{@const Icon = ICONS[row.kind]}
		<!-- Keyboard handling follows the ARIA tree pattern: one handler on the tree, roving tabindex on the rows. -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<li
			bind:this={els[row.key]}
			class="tree__row"
			class:tree__row--selected={row.key === selected}
			class:tree__row--block={row.path.nodes.length === 0}
			class:tree__row--dragging={row.key === dragKey}
			class:tree__row--drop-before={drop?.key === row.key && drop.where === 'before'}
			class:tree__row--drop-after={drop?.key === row.key && drop.where === 'after'}
			role="treeitem"
			aria-level={row.depth + 1}
			aria-selected={row.key === selected}
			aria-expanded={row.hasChildren ? row.expanded : undefined}
			tabindex={row.key === (focusKey ?? selected ?? rows[0]?.key) ? 0 : -1}
			draggable={onmove ? 'true' : undefined}
			style="--depth: {row.depth}"
			onclick={() => {
				focusKey = row.key;
				onselect(row.key);
			}}
			ondblclick={() => row.hasChildren && ontoggle(row.key, !row.expanded)}
			onfocus={() => (focusKey = row.key)}
			ondragstart={(e) => dragstart(e, row)}
			ondragover={(e) => dragover(e, row)}
			ondragleave={() => drop?.key === row.key && (drop = null)}
			ondrop={(e) => dropOn(e, row)}
			ondragend={dragend}
		>
			{#if row.hasChildren}
				<button
					class="tree__toggle"
					type="button"
					tabindex="-1"
					aria-label={row.expanded ? 'Collapse' : 'Expand'}
					onclick={(e) => {
						e.stopPropagation();
						ontoggle(row.key, !row.expanded);
					}}
				>
					{#if row.expanded}<ChevronDown
							class="fp-ico fp-ico--sm"
							strokeWidth={1.4}
							aria-hidden="true"
						/>{:else}<ChevronRight class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />{/if}
				</button>
			{:else}
				<span class="tree__toggle tree__toggle--none" aria-hidden="true"></span>
			{/if}
			{#if row.severity}
				<span class="tree__mark tree__mark--{row.severity}" title="{row.severity} inside"></span>
			{/if}
			<Icon class="fp-ico fp-ico--sm tree__ico" strokeWidth={1.4} aria-hidden="true" />
			<span class="tree__main">
				<span class="tree__line">
					<span class="tree__name" class:t-mono={row.path.nodes.length > 0 || row.kind === 'site'}
						>{row.name}</span
					>
					{#if row.matcher}<span class="fp-tag tree__matcher">{row.matcher}</span>{/if}
					{#if row.summary}<span class="tree__summary t-mono">{row.summary}</span>{/if}
				</span>
				{#if row.note}<span class="tree__note t-caption">{row.note}</span>{/if}
			</span>
		</li>
	{/each}
	{#if rows.length === 0}
		<li class="tree__empty t-ui t-muted" role="none">Nothing here yet.</li>
	{/if}
</ul>

<style>
	.tree {
		list-style: none;
		margin: 0;
		padding: var(--space-1);
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.tree__row {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 30px;
		padding: 2px var(--space-2) 2px calc(var(--space-1) + var(--depth) * 16px);
		border-radius: var(--radius-sm);
		cursor: default;
		user-select: none;
	}
	.tree__row:hover {
		background: var(--hover-tint);
	}
	.tree__row--selected,
	.tree__row--selected:hover {
		background: var(--acc-soft);
	}
	.tree__row:focus-visible {
		box-shadow: var(--focus-ring);
		outline: 0;
	}
	.tree__row--block {
		margin-top: var(--space-1);
	}
	.tree__row--block .tree__name {
		font-weight: 600;
	}
	.tree__row--dragging {
		opacity: 0.5;
	}
	.tree__row--drop-before::before,
	.tree__row--drop-after::after {
		content: '';
		position: absolute;
		left: calc(var(--space-1) + var(--depth) * 16px);
		right: var(--space-2);
		height: 2px;
		background: var(--acc-ink);
		border-radius: 1px;
	}
	.tree__row--drop-before::before {
		top: -1px;
	}
	.tree__row--drop-after::after {
		bottom: -1px;
	}
	.tree__toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		flex: none;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		padding: 0;
	}
	.tree__toggle:hover {
		background: var(--raised);
		color: var(--text);
	}
	.tree__mark {
		position: absolute;
		left: 0;
		top: 8px;
		bottom: 8px;
		width: 3px;
		border-radius: 2px;
	}
	.tree__mark--error {
		background: var(--error-ink);
	}
	.tree__mark--warning {
		background: var(--warning-ink);
	}
	.tree__mark--info {
		background: var(--acc-ink);
	}
	:global(.tree__ico) {
		flex: none;
		color: var(--muted);
	}
	.tree__main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.tree__line {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-width: 0;
	}
	.tree__name {
		font-size: 13px;
		white-space: nowrap;
	}
	.tree__matcher {
		flex: none;
	}
	.tree__summary {
		font-size: 12px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.tree__note {
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tree__empty {
		padding: var(--space-3);
	}
</style>
