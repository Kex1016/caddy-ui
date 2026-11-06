<script lang="ts">
	import { ArrowDown, ArrowUp, Copy, ExternalLink, EyeOff, FileCode, Plus, Trash2 } from '@lucide/svelte';
	import {
		MATCHERLESS_DIRECTIVES,
		commentOutBlock,
		createDirective,
		createMatcherDef,
		createToken,
		insertBlock,
		insertNode,
		parse,
		printBlockText,
		relayout,
		removeBlock,
		removeNode,
		type Block,
		type Caddyfile,
		type Node
	} from '@caddy-ui/caddyfile';
	import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
	import { Notice, Tag } from '$lib/design/components';
	import type { EditorDiagnostic } from '$lib/editor/analyze';
	import {
		childPath,
		childrenOf,
		diagnosticsByPath,
		ensureChildren,
		isBlock,
		parentPath,
		pathKey,
		pruneEmptyBody,
		resolvePath,
		type NodePath
	} from '../document';
	import { unclaimedLines, type FormContext, type ListField, type TextField } from '../forms/types';
	import {
		addableNames,
		cloneTree,
		formContextFor,
		formForPath,
		leadingBlanks,
		matcherInsertIndex,
		nodesFromRaw,
		rawTextOf,
		roleOf,
		setSiteAddresses,
		uniqueMatcherName
	} from '../inspect';
	import { effectiveOrderView } from '../order';
	import { blockName, rowNameOf } from '../tree';
	import EffectiveOrder from './EffectiveOrder.svelte';
	import FormRenderer from './FormRenderer.svelte';
	import MatcherBuilder from './MatcherBuilder.svelte';
	import MatcherSlot from './MatcherSlot.svelte';
	import RawEditor from './RawEditor.svelte';
	import ListInput from './fields/ListInput.svelte';
	import TextInput from './fields/TextInput.svelte';

	type Props = {
		file: Caddyfile;
		diagnostics: readonly EditorDiagnostic[];
		schema: SchemaBundle | null;
		path: NodePath;
		/** Apply a mutation to the file; `select` names what to select afterwards (undefined keeps the selection). */
		edit: (mutate: (file: Caddyfile) => void, select?: NodePath | null) => void;
		onselect: (path: NodePath | null) => void;
		/** Make sure a path's children are visible in the tree. */
		onexpand: (path: NodePath) => void;
		/** Open the text editor at an offset. */
		onshowtext?: (offset: number) => void;
	};
	let { file, diagnostics, schema, path, edit, onselect, onexpand, onshowtext }: Props = $props();

	const resolved = $derived(resolvePath(file, path));
	const target = $derived(resolved?.target);
	const node = $derived(resolved?.node);
	const block = $derived(resolved?.block);
	const role = $derived(roleOf(file, path));
	const lookup = $derived(formForPath(schema, file, path));
	const ctx = $derived<FormContext>(formContextFor(schema, file, path));
	const own = $derived(diagnosticsByPath(file, diagnostics).get(pathKey(path))?.own ?? []);
	const isContainer = $derived(
		(node?.kind === 'directive' && lookup?.spec.container) ||
			(!node && block !== undefined && block.kind !== 'import' && block.kind !== 'raw')
	);
	const addNames = $derived(addableNames(schema, file, path));
	const canAdd = $derived(
		isContainer || (!node && block?.kind === 'global') || (node?.kind === 'directive' && addNames.length > 0)
	);
	const directive = $derived(node?.kind === 'directive' ? node : undefined);
	const unclaimed = $derived(directive && lookup ? unclaimedLines(lookup.spec, directive) : []);
	const siblings = $derived(resolved?.parent ?? file.blocks);
	const index = $derived(node ? (resolved?.index ?? 0) : path.block);
	const title = $derived(target ? (isBlock(target) ? blockName(target) : rowNameOf(target)) : '');
	const kindLabel = $derived.by(() => {
		if (!target) return '';
		if (isBlock(target)) {
			return {
				global: 'global options',
				snippet: 'snippet',
				named_route: 'named route',
				site: 'site',
				import: 'import',
				raw: 'unparsed line'
			}[target.kind];
		}
		switch (role) {
			case 'global_option':
				return 'global option';
			case 'matcher':
				return 'named matcher';
			case 'response_matcher':
				return 'response matcher';
			case 'matcher_module':
				return 'matcher module';
			case 'subdirective':
				return 'subdirective';
			case 'raw':
				return 'unparsed line';
			default:
				return 'directive';
		}
	});

	// Adding things: a directive by name, a named matcher, or lines typed as text.
	let adding = $state<null | 'directive' | 'text'>(null);
	let newName = $state('');
	let rawMode = $state(false);
	let linesMode = $state(false);
	const addId = `add-${Math.random().toString(36).slice(2, 8)}`;
	const LINES_PLACEHOLDER = 'encode gzip\nfile_server';
	$effect(() => {
		// A new selection starts in form mode.
		void pathKey(path);
		rawMode = false;
		linesMode = false;
		adding = null;
	});

	let selectAfterCommit: NodePath | null | undefined = undefined;
	function commit() {
		const next = selectAfterCommit;
		selectAfterCommit = undefined;
		edit(() => {}, next);
	}

	function addDirective() {
		const name = newName.trim();
		if (!name) return;
		const owner = target;
		if (!owner) return;
		const body = ensureChildren(owner);
		const at = body.length;
		edit(
			(f) => {
				const o = resolvePath(f, path)?.target;
				if (o) insertNode(ensureChildren(o), createDirective(name));
			},
			childPath(path, at)
		);
		onexpand(path);
		newName = '';
		adding = null;
	}

	function addMatcher() {
		if (!target) return;
		const body = ensureChildren(target);
		const name = uniqueMatcherName(body);
		const at = matcherInsertIndex(body);
		edit(
			() => insertNode(body, createMatcherDef(name, { module: 'path', args: ['/'] }), at),
			childPath(path, at)
		);
		onexpand(path);
	}

	function addLines(text: string): string | void {
		if (!target) return;
		let nodes: Node[];
		try {
			nodes = nodesFromRaw(text, ctxForChildren());
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
		if (!nodes.length) return 'Nothing to add.';
		const body = ensureChildren(target);
		const at = body.length;
		edit(() => nodes.forEach((n, i) => insertNode(body, n, at + i)), childPath(path, at));
		onexpand(path);
		adding = null;
	}
	const ctxForChildren = () => (node ? Boolean(lookup?.spec.container) : block?.kind !== 'global');

	/** Replace the selected node (or block) with what the raw text parses to. */
	function applyRaw(text: string): string | void {
		if (!target) return;
		try {
			if (isBlock(target)) {
				const r = parse(text);
				const err = r.diagnostics.find((d) => d.severity === 'error');
				if (err) return err.message;
				const blocks = r.file.blocks.map((b) => relayout(b));
				edit(
					(f) => {
						f.blocks.splice(path.block, 1, ...blocks);
					},
					blocks.length ? { block: path.block, nodes: [] } : null
				);
			} else {
				const nodes = nodesFromRaw(text, ctx.holdsDirectives);
				const parent = resolved?.parent;
				if (!parent) return;
				const i = resolved?.index ?? 0;
				if (nodes[0]) nodes[0].trivia = [...leadingBlanks(target), ...nodes[0].trivia];
				edit(
					(f) => {
						parent.splice(i, 1, ...nodes);
						const owner = resolvePath(f, parentPath(path))?.target;
						if (owner && !isBlock(owner)) pruneEmptyBody(owner);
					},
					nodes.length ? path : parentPath(path)
				);
			}
			rawMode = false;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	/** The "other lines" a form does not model, edited as text and put back in place. */
	function applyLines(text: string): string | void {
		if (!directive) return;
		try {
			const nodes = nodesFromRaw(text, Boolean(lookup?.spec.container));
			edit(() => {
				const keep = (directive.body ?? []).filter((n) => !unclaimed.includes(n));
				directive.body = [...keep, ...nodes];
				pruneEmptyBody(directive);
			}, path);
			linesMode = false;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	function remove() {
		if (!resolved) return;
		if (node && resolved.parent) {
			const parent = resolved.parent;
			edit((f) => {
				removeNode(parent, node);
				const owner = resolvePath(f, parentPath(path))?.target;
				if (owner && !isBlock(owner)) pruneEmptyBody(owner);
			}, parentPath(path));
		} else {
			edit((f) => removeBlock(f, resolved.block), null);
		}
	}

	function duplicate() {
		if (!resolved) return;
		if (node && resolved.parent) {
			const parent = resolved.parent;
			const i = resolved.index ?? 0;
			edit(() => insertNode(parent, cloneTree(node), i + 1), {
				block: path.block,
				nodes: [...path.nodes.slice(0, -1), i + 1]
			});
		} else {
			edit((f) => insertBlock(f, cloneTree(resolved.block), path.block + 1), {
				block: path.block + 1,
				nodes: []
			});
		}
	}

	function move(dir: -1 | 1) {
		const list: (Block | Node)[] = siblings;
		const j = index + dir;
		if (j < 0 || j >= list.length) return;
		edit(
			() => {
				const [item] = list.splice(index, 1);
				list.splice(j, 0, item!);
			},
			node ? { block: path.block, nodes: [...path.nodes.slice(0, -1), j] } : { block: j, nodes: [] }
		);
	}

	function disable() {
		if (!block) return;
		edit((f) => {
			commentOutBlock(f, block);
		}, null);
	}

	/** MatcherSlot asks for a new named matcher next to this directive. */
	function newMatcherHere(): string | undefined {
		const parent = resolved?.parent;
		if (!parent || !node) return undefined;
		const name = uniqueMatcherName(parent);
		const at = matcherInsertIndex(parent);
		insertNode(parent, createMatcherDef(name, { module: 'path', args: ['/'] }), at);
		const i = resolved?.index ?? 0;
		if (at <= i) selectAfterCommit = { block: path.block, nodes: [...path.nodes.slice(0, -1), i + 1] };
		return name;
	}

	function gotoMatcher(name: string) {
		const body = block ? (childrenOf(block) ?? []) : [];
		const find = (nodes: readonly Node[], base: NodePath): NodePath | null => {
			for (let i = 0; i < nodes.length; i++) {
				const n = nodes[i]!;
				const p = childPath(base, i);
				if (n.kind === 'matcher' && n.name.text === name) return p;
				if (n.kind === 'directive' && n.body) {
					const hit = find(n.body, p);
					if (hit) return hit;
				}
			}
			return null;
		};
		const hit = find(body, { block: path.block, nodes: [] });
		if (hit) {
			onexpand(parentPath(hit));
			onselect(hit);
		}
	}

	function selectChild(i: number) {
		onexpand(path);
		onselect(childPath(path, i));
	}

	// Blocks' own fields: a site's addresses, a snippet's or named route's name.
	const dummy = createDirective('block');
	const addressesField = $derived<ListField | null>(
		block?.kind === 'site' && !node
			? {
					kind: 'list',
					id: 'addresses',
					label: 'Addresses',
					type: 'string',
					placeholder: 'app.example.com',
					help: 'Hostnames, with an optional scheme, port or path. Several addresses share this block.',
					get: () => block.addresses.map((t) => t.text),
					set: (_n, v) => setSiteAddresses(block, v)
				}
			: null
	);
	const nameField = $derived<TextField | null>(
		(block?.kind === 'snippet' || block?.kind === 'named_route') && !node
			? {
					kind: 'text',
					id: 'name',
					label: block.kind === 'snippet' ? 'Snippet name' : 'Route name',
					type: 'string',
					required: true,
					placeholders: false,
					help:
						block.kind === 'snippet'
							? 'Used as import <name>. Renaming does not update the imports.'
							: 'Used as invoke <name>.',
					get: () => block.name,
					set: (_n, v) => {
						const name = (v ?? '').trim().replace(/^&?\(|\)$/g, '');
						if (!name) return;
						block.name = name;
						block.nameToken = createToken(block.kind === 'snippet' ? `(${name})` : `&(${name})`);
					}
				}
			: null
	);
	const orderView = $derived(isContainer && target ? effectiveOrderView(schema, file, target) : null);
	const docsUrl = $derived(lookup?.spec.docsUrl);
	const offset = $derived(target?.span?.start);
	const matcherAllowed = $derived(
		directive !== undefined &&
			role === 'directive' &&
			ctx.holdsDirectives &&
			!MATCHERLESS_DIRECTIVES.has(directive.name.text)
	);
</script>

{#if !target || !block}
	<div class="ins"><p class="t-ui t-muted">Select something in the outline.</p></div>
{:else}
	<div class="ins">
		<header class="ins__head">
			<div class="ins__titles">
				<span class="t-kicker">{kindLabel}</span>
				<h2 class="ins__title" class:t-mono={node !== undefined || block.kind === 'site'}>{title}</h2>
				{#if lookup?.spec.summary}<p class="t-caption t-muted">{lookup.spec.summary}</p>{/if}
			</div>
			<div class="ins__tags">
				{#if lookup?.source === 'schema'}<Tag>schema form</Tag>{/if}
				{#if lookup?.source === 'unknown'}<Tag kind="warning">unknown to the schema</Tag>{/if}
				{#if docsUrl}
					<a class="fp-btn fp-btn--quiet" href={docsUrl} target="_blank" rel="noreferrer">
						docs <ExternalLink class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
					</a>
				{/if}
			</div>
		</header>

		{#each own as d, i (i)}
			<Notice kind={d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info'}
				>{d.message}</Notice
			>
		{/each}

		<div class="ins__actions" role="toolbar" aria-label="Actions">
			<button class="fp-btn fp-btn--quiet" type="button" onclick={() => move(-1)} disabled={index === 0}>
				<ArrowUp class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Up
			</button>
			<button
				class="fp-btn fp-btn--quiet"
				type="button"
				onclick={() => move(1)}
				disabled={index >= siblings.length - 1}
			>
				<ArrowDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Down
			</button>
			<button class="fp-btn fp-btn--quiet" type="button" onclick={duplicate}>
				<Copy class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Duplicate
			</button>
			{#if !node && block.kind === 'site'}
				<button
					class="fp-btn fp-btn--quiet"
					type="button"
					onclick={disable}
					title="Comment the block out; the Sites page can enable it again"
				>
					<EyeOff class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Disable
				</button>
			{/if}
			<button class="fp-btn fp-btn--quiet" type="button" onclick={remove}>
				<Trash2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Delete
			</button>
			{#if onshowtext && offset !== undefined}
				<button class="fp-btn fp-btn--quiet" type="button" onclick={() => onshowtext(offset)}>
					<FileCode class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> In text
				</button>
			{/if}
			{#if node || block.kind === 'site' || block.kind === 'snippet' || block.kind === 'named_route'}
				<button
					class="fp-btn fp-btn--quiet ins__raw"
					type="button"
					aria-pressed={rawMode}
					onclick={() => (rawMode = !rawMode)}
				>
					Edit as text
				</button>
			{/if}
		</div>

		{#if rawMode}
			<RawEditor
				text={isBlock(target) ? printBlockText(target).replace(/\s+$/, '') : rawTextOf(target)}
				label="Text of {title}"
				onapply={applyRaw}
				oncancel={() => (rawMode = false)}
				rows={10}
			/>
		{:else}
			{#if addressesField}
				<ListInput field={addressesField} node={dummy} {ctx} {commit} />
			{/if}
			{#if nameField}
				<TextInput field={nameField} node={dummy} {ctx} {commit} />
			{/if}

			{#if !node && block.kind === 'global'}
				<p class="t-ui t-muted">
					Options that apply to the whole server. Pick one in the outline to edit it, or add one below.
				</p>
			{:else if !node && block.kind === 'import'}
				{@const l = formForPath(schema, file, path)}
				<FormRenderer fields={lookup?.spec.fields ?? l?.spec.fields ?? []} node={block.node} {ctx} {commit} />
			{:else if !node && block.kind === 'raw'}
				<Notice kind="warning">The parser could not read this line. Edit it as text.</Notice>
				<RawEditor text={rawTextOf(block.node)} onapply={applyRaw} rows={4} />
			{/if}

			{#if node?.kind === 'raw'}
				<Notice kind="warning"
					>The parser could not classify this line, so it has no form. It is kept as written.</Notice
				>
				<RawEditor text={rawTextOf(node)} onapply={applyRaw} rows={4} />
			{:else if node?.kind === 'matcher'}
				<MatcherBuilder
					def={node}
					{schema}
					{ctx}
					{commit}
					response={role === 'response_matcher'}
					blockBody={childrenOf(block)}
				/>
			{:else if directive && lookup}
				{#if matcherAllowed}
					<MatcherSlot node={directive} {ctx} {commit} onnew={newMatcherHere} ongoto={gotoMatcher} />
				{/if}
				{#if lookup.spec.fields.length}
					<FormRenderer fields={lookup.spec.fields} node={directive} {ctx} {commit} />
				{:else if lookup.source === 'unknown'}
					<Notice
						>No form for <code>{directive.name.text}</code>. Edit it as text; it is kept exactly as written.</Notice
					>
					<RawEditor text={rawTextOf(directive)} onapply={applyRaw} rows={4} />
				{/if}
				{#if unclaimed.length && !lookup.spec.container}
					<section class="ins__other">
						<div class="ins__otherhead">
							<span class="t-ui ins__otherlabel">Other lines</span>
							<span class="t-caption t-muted"
								>{unclaimed.length} {unclaimed.length === 1 ? 'line' : 'lines'} the form does not cover</span
							>
							<button
								class="fp-btn fp-btn--quiet"
								type="button"
								aria-pressed={linesMode}
								onclick={() => (linesMode = !linesMode)}>Edit</button
							>
						</div>
						{#if linesMode}
							<RawEditor
								text={unclaimed.map(rawTextOf).join('\n')}
								onapply={applyLines}
								oncancel={() => (linesMode = false)}
							/>
						{:else}
							<ul class="ins__lines">
								{#each unclaimed as line (line)}
									<li>
										<button
											type="button"
											class="ins__line t-mono"
											onclick={() => selectChild((directive.body ?? []).indexOf(line))}
											>{rawTextOf(line).split('\n')[0]}</button
										>
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}
			{/if}

			{#if canAdd}
				<section class="ins__add">
					<div class="ins__addrow">
						<span class="t-ui ins__otherlabel">Add</span>
						<button
							class="fp-btn fp-btn--quiet"
							type="button"
							aria-pressed={adding === 'directive'}
							onclick={() => (adding = adding === 'directive' ? null : 'directive')}
						>
							<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
							{!node && block.kind === 'global' ? 'Option' : isContainer ? 'Directive' : 'Line'}
						</button>
						{#if isContainer && block.kind !== 'global'}
							<button class="fp-btn fp-btn--quiet" type="button" onclick={addMatcher}>
								<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Named matcher
							</button>
						{/if}
						<button
							class="fp-btn fp-btn--quiet"
							type="button"
							aria-pressed={adding === 'text'}
							onclick={() => (adding = adding === 'text' ? null : 'text')}
						>
							<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Lines as text
						</button>
					</div>
					{#if adding === 'directive'}
						<form
							class="ins__addform"
							onsubmit={(e) => {
								e.preventDefault();
								addDirective();
							}}
						>
							<label class="visually-hidden" for={addId}>Name</label>
							<span class="fp-field ins__addfield">
								<input
									id={addId}
									list="{addId}-names"
									bind:value={newName}
									placeholder="name, such as encode"
									spellcheck="false"
									autocomplete="off"
								/>
							</span>
							<datalist id="{addId}-names">
								{#each addNames as n (n)}<option value={n}></option>{/each}
							</datalist>
							<button class="fp-btn" type="submit" disabled={!newName.trim()}>Add</button>
						</form>
					{:else if adding === 'text'}
						<RawEditor
							text=""
							placeholder={LINES_PLACEHOLDER}
							onapply={addLines}
							oncancel={() => (adding = null)}
							applyLabel="Add lines"
						/>
					{/if}
				</section>
			{/if}

			{#if orderView && orderView.rows.length > 1}
				<section class="ins__order">
					<span class="t-ui ins__otherlabel">Order Caddy runs these in</span>
					<EffectiveOrder view={orderView} onselect={selectChild} />
				</section>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.ins {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
	.ins__head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.ins__titles {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.ins__title {
		margin: 0;
		font: 600 18px/24px var(--font-head);
		overflow-wrap: anywhere;
	}
	.ins__title.t-mono {
		font-size: 16px;
	}
	.ins__tags {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.ins__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--line-soft);
	}
	.ins__raw {
		margin-left: auto;
	}
	.ins__other,
	.ins__add,
	.ins__order {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--line-soft);
	}
	.ins__otherhead,
	.ins__addrow {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.ins__otherlabel {
		font-weight: 500;
	}
	.ins__otherhead > :global(button) {
		margin-left: auto;
	}
	.ins__lines {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.ins__line {
		display: block;
		width: 100%;
		border: 0;
		border-radius: var(--radius-sm);
		background: var(--sunk);
		padding: var(--space-1) var(--space-2);
		color: var(--text);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ins__line:hover {
		background: var(--raised);
	}
	.ins__addform {
		display: flex;
		gap: var(--space-2);
	}
	.ins__addfield {
		flex: 1;
	}
	.ins__addfield input {
		font-family: var(--font-mono);
		font-size: 13px;
	}
</style>
