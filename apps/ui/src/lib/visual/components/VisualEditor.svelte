<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { ChevronsDownUp, ChevronsUpDown, Plus, Search } from '@lucide/svelte';
	import { insertBlock, parse, relayout, type Block, type Caddyfile } from '@caddy-ui/caddyfile';
	import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
	import { Dialog, EmptyState, Notice } from '$lib/design/components';
	import {
		editDocument,
		loadDocument,
		parentPath,
		parsePathKey,
		pathAt,
		pathKey,
		resolvePath,
		type DocumentState,
		type NodePath
	} from '../document';
	import { RECIPES, RecipeError, recipeById, recipeDefaults, renderRecipe } from '../recipes';
	import { allExpandableKeys, flattenTree } from '../tree';
	import Inspector from './Inspector.svelte';
	import RecipePicker from './RecipePicker.svelte';
	import Tree from './Tree.svelte';

	type Props = {
		/** The current text. The parent keeps it up to date from `onchange`. */
		text: string;
		schema: SchemaBundle | null;
		onchange: (text: string) => void;
		/** `globals` hides site blocks (the Globals page). */
		scope?: 'all' | 'globals';
		/** Open the text editor at an offset ("In text"). */
		onshowtext?: (offset: number) => void;
	};
	let { text, schema, onchange, scope = 'all', onshowtext }: Props = $props();

	// svelte-ignore state_referenced_locally
	let doc = $state.raw<DocumentState>(loadDocument(text, schema));
	let lastSchema: SchemaBundle | null = null;
	$effect(() => {
		// Reload when the parent hands us different text (text mode edits, apply, reload) or the schema arrives.
		const t = text;
		const s = schema;
		if (t !== doc.text || s !== lastSchema) {
			lastSchema = s;
			doc = loadDocument(t, s);
		}
	});

	const expanded = new SvelteSet<string>();
	let selectedKey = $state<string | null>(null);
	let query = $state('');
	let expandedOnce = false;

	const blockFilter = $derived<((b: Block, i: number) => boolean) | undefined>(
		scope === 'globals' ? (b) => b.kind !== 'site' : undefined
	);
	const rows = $derived(
		flattenTree(doc.file, { expanded, diagnostics: doc.diagnostics, blockFilter, query })
	);
	const selectedPath = $derived.by(() => {
		if (!selectedKey) return null;
		const p = parsePathKey(selectedKey);
		return p && resolvePath(doc.file, p) ? p : null;
	});
	const visibleBlocks = $derived(doc.file.blocks.filter((b, i) => !blockFilter || blockFilter(b, i)));

	$effect(() => {
		// Open every top-level block the first time there is a file to show.
		if (expandedOnce || doc.file.blocks.length === 0) return;
		expandedOnce = true;
		doc.file.blocks.forEach((_, i) => expanded.add(pathKey({ block: i, nodes: [] })));
	});

	function edit(mutate: (file: Caddyfile) => void, select?: NodePath | null) {
		doc = editDocument(doc, schema, mutate);
		if (select !== undefined) selectedKey = select ? pathKey(select) : null;
		onchange(doc.text);
	}

	function expandTo(path: NodePath) {
		let p = path;
		for (;;) {
			expanded.add(pathKey(p));
			if (p.nodes.length === 0) break;
			p = parentPath(p);
		}
	}

	export function selectPath(path: NodePath | null) {
		if (path) expandTo(path.nodes.length ? parentPath(path) : path);
		selectedKey = path ? pathKey(path) : null;
	}
	/** Select the innermost node at a text offset (for `?line=`, `?at=` and the problems list). */
	export function selectOffset(offset: number): boolean {
		const p = pathAt(doc.file, offset);
		if (!p) return false;
		selectPath(p);
		return true;
	}
	export function selectBlock(test: (b: Block) => boolean): boolean {
		const i = doc.file.blocks.findIndex(test);
		if (i < 0) return false;
		selectPath({ block: i, nodes: [] });
		return true;
	}
	export function expandAll() {
		for (const k of allExpandableKeys(doc.file, blockFilter)) expanded.add(k);
	}
	export function collapseAll() {
		expanded.clear();
	}

	function onmove(from: { path: NodePath }, to: { path: NodePath }, where: 'before' | 'after') {
		const f = from.path;
		const t = to.path;
		if (f.nodes.length === 0) {
			edit((file) => {
				const [b] = file.blocks.splice(f.block, 1);
				let at = t.block > f.block ? t.block - 1 : t.block;
				if (where === 'after') at++;
				file.blocks.splice(at, 0, b!);
			}, null);
			const at = (t.block > f.block ? t.block - 1 : t.block) + (where === 'after' ? 1 : 0);
			selectedKey = pathKey({ block: at, nodes: [] });
			return;
		}
		const fi = f.nodes[f.nodes.length - 1]!;
		const ti = t.nodes[t.nodes.length - 1]!;
		let at = ti > fi ? ti - 1 : ti;
		if (where === 'after') at++;
		edit(
			(file) => {
				const list = resolvePath(file, parentPath(f))?.target;
				const body = list ? (resolvePath(file, f)?.parent ?? null) : null;
				if (!body) return;
				const [n] = body.splice(fi, 1);
				body.splice(at, 0, n!);
			},
			{ block: f.block, nodes: [...f.nodes.slice(0, -1), at] }
		);
	}

	// Adding a top-level block: a recipe for a site or snippet, or a bare global options / named route block.
	let adding = $state(false);
	let recipe = $state('reverse_proxy');
	let values = $state<Record<string, string>>(recipeDefaults(RECIPES[0]!));
	let header = $state('');
	let addError = $state<{ field: string; message: string } | null>(null);
	let special = $state<'' | 'global' | 'named_route'>('');
	const chosen = $derived(recipeById(recipe));
	const hasGlobal = $derived(doc.file.blocks.some((b) => b.kind === 'global'));
	const kinds = $derived<('site' | 'snippet')[]>(scope === 'globals' ? ['snippet'] : ['site', 'snippet']);

	function openAdd() {
		addError = null;
		header = '';
		special = '';
		if (scope === 'globals' && chosen?.kind !== 'snippet') {
			recipe = 'snippet';
			values = recipeDefaults(recipeById('snippet')!);
		}
		adding = true;
	}

	function insertAt(file: Caddyfile, block: Block): number {
		const kinds = file.blocks.map((b) => b.kind);
		let at = file.blocks.length;
		if (block.kind === 'global') at = 0;
		else if (block.kind === 'snippet' || block.kind === 'named_route') {
			// after the last snippet / named route, else after the global block, else first
			const last = Math.max(kinds.lastIndexOf('snippet'), kinds.lastIndexOf('named_route'));
			at = last >= 0 ? last + 1 : kinds[0] === 'global' ? 1 : 0;
		}
		insertBlock(file, block, at);
		return at;
	}

	function submitAdd(e: SubmitEvent) {
		e.preventDefault();
		addError = null;
		try {
			let block: Block;
			if (special === 'global') block = { kind: 'global', body: [], trivia: [] };
			else if (special === 'named_route') {
				const name = header.trim().replace(/^&?\(|\)$/g, '');
				if (!/^[A-Za-z0-9_.-]+$/.test(name))
					throw new RecipeError('name', 'Route names use letters, digits, _ . and -.');
				block = {
					kind: 'named_route',
					name,
					nameToken: { text: `&(${name})`, quote: 'none' },
					body: [],
					trivia: []
				};
			} else {
				if (!chosen) return;
				const text =
					chosen.kind === 'snippet'
						? renderRecipe(chosen, {}, values)
						: renderRecipe(
								chosen,
								{
									addresses: header
										.split(/[\s,]+/)
										.map((a) => a.trim())
										.filter(Boolean)
								},
								values
							);
				const r = parse(text);
				const err = r.diagnostics.find((d) => d.severity === 'error');
				if (err) throw new RecipeError('addresses', err.message);
				block = relayout(r.file.blocks[0]!);
			}
			let at = 0;
			edit((file) => {
				at = insertAt(file, block);
			}, null);
			selectPath({ block: at, nodes: [] });
			adding = false;
		} catch (err) {
			if (err instanceof RecipeError) addError = { field: err.field, message: err.message };
			else addError = { field: 'addresses', message: err instanceof Error ? err.message : String(err) };
		}
	}
	const headerLabel = $derived(
		special === 'named_route'
			? 'Route name'
			: special === 'global' || chosen?.kind === 'snippet'
				? ''
				: 'Addresses'
	);
</script>

<div class="ve">
	<div class="ve__bar">
		<label class="fp-field fp-search ve__search">
			<Search class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
			<input
				type="search"
				placeholder="Find in the outline"
				aria-label="Find in the outline"
				bind:value={query}
			/>
		</label>
		<span class="ve__barend">
			<button class="fp-ibtn" type="button" title="Expand all" aria-label="Expand all" onclick={expandAll}>
				<ChevronsUpDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
			</button>
			<button
				class="fp-ibtn"
				type="button"
				title="Collapse all"
				aria-label="Collapse all"
				onclick={collapseAll}
			>
				<ChevronsDownUp class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
			</button>
			<button class="fp-btn" type="button" onclick={openAdd}>
				<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Add block
			</button>
		</span>
	</div>

	{#if visibleBlocks.length === 0}
		<EmptyState
			title={scope === 'globals' ? 'No global options or snippets yet' : 'The Caddyfile is empty'}
			line="Add a block to start. Everything you add shows up in the text too."
		>
			<button class="fp-btn fp-btn--primary" type="button" onclick={openAdd}>
				<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Add block
			</button>
		</EmptyState>
	{:else}
		<div class="ve__cols">
			<div class="fp-panel ve__tree">
				<Tree
					{rows}
					selected={selectedKey}
					onselect={(k) => (selectedKey = k)}
					ontoggle={(k, on) => (on ? expanded.add(k) : expanded.delete(k))}
					{onmove}
				/>
			</div>
			<div class="fp-panel ve__inspector">
				{#if selectedPath}
					{#key selectedKey}
						<Inspector
							file={doc.file}
							diagnostics={doc.diagnostics}
							{schema}
							path={selectedPath}
							{edit}
							onselect={(p) => (selectedKey = p ? pathKey(p) : null)}
							onexpand={expandTo}
							{onshowtext}
						/>
					{/key}
				{:else}
					<p class="t-ui t-muted">Pick a site, a directive or a matcher in the outline to edit it here.</p>
					<p class="t-caption t-muted">
						Arrow keys move around the outline, Enter opens, Delete removes, Ctrl+D duplicates. Drag a row to
						reorder it among its siblings.
					</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

<Dialog bind:open={adding} title="Add a block">
	<form class="ve__add" onsubmit={submitAdd}>
		{#if scope !== 'globals' || !hasGlobal}
			<div class="fp-chips" role="group" aria-label="Kind of block">
				<button class="fp-chip" type="button" aria-pressed={special === ''} onclick={() => (special = '')}
					>From a recipe</button
				>
				{#if !hasGlobal}
					<button
						class="fp-chip"
						type="button"
						aria-pressed={special === 'global'}
						onclick={() => (special = 'global')}>Global options</button
					>
				{/if}
				<button
					class="fp-chip"
					type="button"
					aria-pressed={special === 'named_route'}
					onclick={() => (special = 'named_route')}>Named route</button
				>
			</div>
		{/if}
		{#if special === 'global'}
			<p class="t-ui t-muted">
				An empty global options block at the top of the file. Add options to it in the outline.
			</p>
		{:else}
			{#if special === ''}
				<RecipePicker bind:recipe bind:values {kinds} error={addError} />
			{/if}
			{#if headerLabel}
				<div class="ve__addfield">
					<label class="t-ui ve__addlabel" for="ve-add-header">{headerLabel}</label>
					<span
						class="fp-field"
						class:ve__bad={addError?.field === 'addresses' || addError?.field === 'name'}
					>
						<input
							id="ve-add-header"
							bind:value={header}
							placeholder={headerLabel === 'Addresses' ? 'app.example.com' : 'common'}
							required
							spellcheck="false"
							autocomplete="off"
						/>
					</span>
					{#if addError && (addError.field === 'addresses' || addError.field === 'name')}
						<span class="t-caption ve__err">{addError.message}</span>
					{:else if headerLabel === 'Addresses'}
						<span class="t-caption t-muted">Several addresses can be separated by commas.</span>
					{/if}
				</div>
			{/if}
		{/if}
		{#if addError && addError.field !== 'addresses' && addError.field !== 'name' && !chosen?.fields.some((f) => f.id === addError?.field)}
			<Notice kind="error">{addError.message}</Notice>
		{/if}
		<div class="ve__addfoot">
			<button class="fp-btn" type="button" onclick={() => (adding = false)}>Cancel</button>
			<button class="fp-btn fp-btn--primary" type="submit">Add</button>
		</div>
	</form>
</Dialog>

<style>
	.ve {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
	}
	.ve__bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.ve__search {
		flex: 1;
		min-width: 12rem;
		max-width: 24rem;
	}
	.ve__barend {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
	}
	.ve__cols {
		display: grid;
		grid-template-columns: minmax(16rem, 2fr) minmax(0, 3fr);
		gap: var(--space-4);
		align-items: start;
	}
	.ve__tree {
		padding: var(--space-2);
		position: sticky;
		top: var(--space-4);
		max-height: calc(100vh - 8rem);
		overflow: auto;
	}
	.ve__inspector {
		min-width: 0;
	}
	@media (max-width: 900px) {
		.ve__cols {
			grid-template-columns: 1fr;
		}
		.ve__tree {
			position: static;
			max-height: 20rem;
		}
	}
	.ve__add {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: min(36rem, 80vw);
	}
	.ve__addfield {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.ve__addlabel {
		font-weight: 500;
	}
	.ve__addfield input {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.ve__bad {
		border-color: var(--error-ink);
	}
	.ve__err {
		color: var(--error-ink);
	}
	.ve__addfoot {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
