<script lang="ts">
	import { Plus, Trash2 } from '@lucide/svelte';
	import {
		createDirective,
		isCelShorthand,
		removeNode,
		setMatcher,
		type Directive,
		type MatcherDef,
		type Node
	} from '@caddy-ui/caddyfile';
	import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
	import { Notice } from '$lib/design/components';
	import { formForMatcher } from '../forms';
	import { rawTextOf } from '../inspect';
	import type { FormContext } from '../forms/types';
	import {
		celOfSet,
		matcherModuleNames,
		readMatcherDef,
		writeMatcherDef,
		type MatcherSetModel
	} from '../matcher';
	import FormRenderer from './FormRenderer.svelte';
	import PlaceholderPicker from './fields/PlaceholderPicker.svelte';

	type Props = {
		def: MatcherDef;
		schema: SchemaBundle | null;
		ctx: FormContext;
		commit: () => void;
		/** Response matchers (inside reverse_proxy) use the response matcher modules. */
		response?: boolean;
		/** Nodes that may reference this matcher by name, so a rename follows through. */
		blockBody?: Node[];
	};
	let { def, schema, ctx, commit, response = false, blockBody }: Props = $props();

	const model = $derived(readMatcherDef(def));
	const cel = $derived(def.inline !== undefined && isCelShorthand(def));
	const moduleNodes = $derived<Directive[]>(
		cel
			? []
			: def.inline
				? [def.inline]
				: (def.body ?? []).filter((n): n is Directive => n.kind === 'directive')
	);
	const names = $derived(
		response ? Object.keys(schema?.responseMatchers ?? {}).sort() : matcherModuleNames(schema)
	);
	const preview = $derived(rawTextOf(def));
	const celEquivalent = $derived(cel ? '' : celOfSet(schema, model));
	const id = `mb-${Math.random().toString(36).slice(2, 8)}`;
	let adding = $state('');
	let celEl: HTMLTextAreaElement | undefined = $state();

	function write(next: Partial<MatcherSetModel>) {
		writeMatcherDef(def, { ...model, ...next });
		commit();
	}

	function rename(e: Event) {
		const raw = (e.currentTarget as HTMLInputElement).value.trim().replace(/^@/, '');
		if (!raw || '@' + raw === def.name.text) return;
		const from = def.name.text;
		const to = '@' + raw;
		write({ name: to });
		if (blockBody) {
			const visit = (nodes: Node[]) => {
				for (const n of nodes) {
					if (n.kind === 'directive') {
						if (n.matcher?.text === from) setMatcher(n, to);
						if (n.body) visit(n.body);
					}
				}
			};
			visit(blockBody);
			commit();
		}
	}

	function switchForm(toCel: boolean) {
		if (toCel === cel) return;
		if (toCel) write({ form: 'cel', cel: celOfSet(schema, model), modules: [] });
		else
			write({ form: 'inline', modules: [{ name: 'expression', args: [model.cel ?? ''] }], cel: undefined });
	}

	function addModule(name: string) {
		if (!name) return;
		adding = '';
		write({ form: moduleNodes.length ? 'block' : 'inline', modules: [...model.modules, { name, args: [] }] });
	}

	function removeModule(node: Directive) {
		if (def.inline === node) write({ form: 'block', modules: [] });
		else if (def.body) {
			removeNode(def.body, node);
			commit();
		}
	}

	function setModuleName(node: Directive, name: string) {
		const i = moduleNodes.indexOf(node);
		const modules = model.modules.map((m, j) => (j === i ? { name, args: [] } : m));
		write({ modules });
	}

	/** `not path /x` becomes `not { path /x }` so its nested modules get forms. */
	function expandNot(node: Directive) {
		const [mod, ...args] = node.args.map((a) => a.text);
		if (!mod) return;
		node.body = [createDirective(mod, args)];
		node.args = [];
		commit();
	}
	function addNested(node: Directive, name: string) {
		if (!name) return;
		(node.body ??= []).push(createDirective(name, []));
		commit();
	}
	function removeNested(node: Directive, child: Directive) {
		if (node.body) removeNode(node.body, child);
		commit();
	}

	function setCel(value: string) {
		write({ form: 'cel', cel: value });
	}
	function insertCel(name: string) {
		const el = celEl;
		const value = model.cel ?? '';
		if (!el) return setCel(value + name);
		const s = el.selectionStart ?? value.length;
		const e = el.selectionEnd ?? s;
		setCel(value.slice(0, s) + name + value.slice(e));
	}
</script>

{#snippet moduleCard(node: Directive, remove: () => void, nested: boolean)}
	{@const lookup = formForMatcher(schema, node.name.text, response)}
	<div class="mod" class:mod--nested={nested}>
		<div class="mod__head">
			<span class="fp-select">
				<select
					aria-label="Matcher module"
					value={node.name.text}
					onchange={(e) => setModuleName(node, (e.currentTarget as HTMLSelectElement).value)}
				>
					{#if !names.includes(node.name.text)}<option value={node.name.text}>{node.name.text}</option>{/if}
					{#each names as n (n)}<option value={n}>{n}</option>{/each}
				</select>
			</span>
			{#if lookup.spec.docsUrl}
				<a class="t-caption mod__docs" href={lookup.spec.docsUrl} target="_blank" rel="noreferrer">docs</a>
			{/if}
			<button
				class="fp-ibtn mod__remove"
				type="button"
				aria-label="Remove module"
				title="Remove"
				onclick={remove}
			>
				<Trash2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
			</button>
		</div>
		{#if lookup.spec.summary}<p class="t-caption t-muted">{lookup.spec.summary}</p>{/if}
		{#if node.name.text === 'not' && !nested}
			{#if node.args.length && !node.body}
				<p class="t-caption t-muted">
					Negates <code>{node.args.map((a) => a.text).join(' ')}</code>.
					<button class="fp-btn fp-btn--quiet link" type="button" onclick={() => expandNot(node)}
						>Edit as nested modules</button
					>
				</p>
			{:else}
				<div class="mod__nest">
					{#each node.body?.filter((n): n is Directive => n.kind === 'directive') ?? [] as child (child)}
						{@render moduleCard(child, () => removeNested(node, child), true)}
					{/each}
					<span class="fp-select">
						<select
							aria-label="Add a module inside not"
							value=""
							onchange={(e) => {
								addNested(node, (e.currentTarget as HTMLSelectElement).value);
								(e.currentTarget as HTMLSelectElement).value = '';
							}}
						>
							<option value="">Add a module to negate…</option>
							{#each names.filter((n) => n !== 'not') as n (n)}<option value={n}>{n}</option>{/each}
						</select>
					</span>
				</div>
			{/if}
		{:else if lookup.spec.fields.length}
			<FormRenderer fields={lookup.spec.fields} {node} {ctx} {commit} />
		{/if}
	</div>
{/snippet}

<div class="mb">
	<div class="mb__name">
		<label class="t-ui mb__label" for="{id}-name">Name</label>
		<span class="fp-field mb__field">
			<span class="t-mono t-muted">@</span>
			<input
				id="{id}-name"
				value={def.name.text.replace(/^@/, '')}
				spellcheck="false"
				autocomplete="off"
				onchange={rename}
			/>
		</span>
		<span class="t-caption t-muted">Renaming updates every directive in this block that uses it.</span>
	</div>

	<div class="fp-seg mb__seg" role="group" aria-label="Matcher form">
		<button type="button" aria-pressed={!cel} onclick={() => switchForm(false)}>Modules</button>
		<button type="button" aria-pressed={cel} onclick={() => switchForm(true)}>Expression (CEL)</button>
	</div>

	{#if cel}
		<div class="mb__cel">
			<label class="t-ui mb__label" for="{id}-cel">Expression</label>
			<div class="mb__celrow">
				<textarea
					id="{id}-cel"
					class="mb__area"
					rows="3"
					bind:this={celEl}
					value={model.cel ?? ''}
					spellcheck="false"
					placeholder={'{method} == "GET" && {path}.startsWith("/api")'}
					onchange={(e) => setCel((e.currentTarget as HTMLTextAreaElement).value)}
				></textarea>
				{#if ctx.placeholders.length}<PlaceholderPicker
						choices={ctx.placeholders}
						oninsert={insertCel}
					/>{/if}
			</div>
			<p class="t-caption t-muted">
				A CEL expression; placeholders like <code>{'{path}'}</code> are replaced before it runs. See the
				<a href="https://caddyserver.com/docs/caddyfile/matchers#expression" target="_blank" rel="noreferrer"
					>expression matcher docs</a
				>.
			</p>
		</div>
	{:else}
		<div class="mb__mods">
			{#each moduleNodes as node (node)}
				{@render moduleCard(node, () => removeModule(node), false)}
			{/each}
			{#if moduleNodes.length > 1}
				<p class="t-caption t-muted">
					Every module must match (they are AND-ed). Use <code>not</code> to negate one.
				</p>
			{:else if moduleNodes.length === 0}
				<Notice kind="warning">An empty matcher matches nothing. Add a module.</Notice>
			{/if}
			<span class="fp-select mb__add">
				<Plus class="fp-ico fp-ico--sm mb__addico" strokeWidth={1.4} aria-hidden="true" />
				<select aria-label="Add a matcher module" bind:value={adding} onchange={() => addModule(adding)}>
					<option value="">Add a module…</option>
					{#each names as n (n)}<option value={n}>{n}</option>{/each}
				</select>
			</span>
		</div>
	{/if}

	<div class="mb__preview">
		<span class="t-kicker">Caddyfile</span>
		<pre class="mb__pre t-mono">{preview}</pre>
		{#if celEquivalent && moduleNodes.length}
			<span class="t-kicker">As an expression</span>
			<pre class="mb__pre mb__pre--cel t-mono">{celEquivalent}</pre>
		{/if}
	</div>
</div>

<style>
	.mb {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.mb__name,
	.mb__cel {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.mb__label {
		font-weight: 500;
	}
	.mb__field input {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.mb__seg {
		align-self: flex-start;
	}
	.mb__mods {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.mod {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-3);
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-lg);
		background: var(--sunk);
	}
	.mod--nested {
		background: var(--surface);
	}
	.mod__head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.mod__docs {
		color: var(--muted);
	}
	.mod__remove {
		margin-left: auto;
	}
	.mod__nest {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding-left: var(--space-4);
		border-left: 2px solid var(--line);
	}
	.mb__add {
		align-self: flex-start;
		padding-left: var(--space-2);
	}
	.mb__celrow {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
	}
	.mb__area {
		flex: 1;
		min-width: 0;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sunk);
		color: var(--text);
		font: 400 13px/20px var(--font-mono);
		resize: vertical;
	}
	.mb__area:focus-visible {
		border-color: var(--acc-ink);
		box-shadow: var(--focus-ring);
	}
	.mb__preview {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.mb__pre {
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		background: var(--sunk);
		font-size: 12px;
		line-height: 18px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		tab-size: 4;
	}
	.mb__pre--cel {
		color: var(--muted);
	}
	.link {
		height: auto;
		padding: 0 var(--space-1);
		color: var(--acc-ink);
	}
</style>
