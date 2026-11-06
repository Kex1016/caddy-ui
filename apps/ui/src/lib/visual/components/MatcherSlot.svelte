<script lang="ts">
	import { setMatcher, type Directive } from '@caddy-ui/caddyfile';
	import type { FormContext } from '../forms/types';

	type Props = {
		node: Directive;
		ctx: FormContext;
		commit: () => void;
		/** Define a new named matcher next to this directive; return its name once inserted. */
		onnew?: () => string | undefined;
		/** Jump to the definition of a named matcher. */
		ongoto?: (name: string) => void;
	};
	let { node, ctx, commit, onnew, ongoto }: Props = $props();

	type Mode = 'all' | 'star' | 'path' | 'named';
	const current = $derived(node.matcher?.text);
	const mode = $derived<Mode>(
		current === undefined ? 'all' : current === '*' ? 'star' : current.startsWith('@') ? 'named' : 'path'
	);
	const id = `ms-${Math.random().toString(36).slice(2, 8)}`;
	const known = $derived(mode !== 'named' || ctx.matcherNames.includes(current ?? ''));

	function choose(e: Event) {
		const v = (e.currentTarget as HTMLSelectElement).value;
		if (v === 'all') setMatcher(node, undefined);
		else if (v === 'star') setMatcher(node, '*');
		else if (v === 'path') setMatcher(node, mode === 'path' && current ? current : '/');
		else if (v === 'new') {
			const name = onnew?.();
			if (name) setMatcher(node, name);
			else {
				(e.currentTarget as HTMLSelectElement).value = selectValue();
				return;
			}
		} else setMatcher(node, v);
		commit();
	}
	function selectValue(): string {
		return mode === 'named' ? (current ?? 'all') : mode;
	}
	function setPath(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value.trim();
		setMatcher(node, v === '' ? '/' : v);
		commit();
	}
</script>

<div class="slot">
	<label class="t-ui slot__label" for={id}>Applies to</label>
	<div class="slot__row">
		<span class="fp-select">
			<select {id} value={selectValue()} onchange={choose}>
				<option value="all">all requests</option>
				<option value="star">all requests (explicit *)</option>
				<option value="path">a path prefix…</option>
				{#if ctx.matcherNames.length}
					<optgroup label="Named matchers">
						{#each ctx.matcherNames as m (m)}<option value={m}>{m}</option>{/each}
					</optgroup>
				{/if}
				{#if mode === 'named' && !known && current}
					<option value={current}>{current} (not defined here)</option>
				{/if}
				{#if onnew}<option value="new">new named matcher…</option>{/if}
			</select>
		</span>
		{#if mode === 'path'}
			<span class="fp-field slot__path">
				<input
					value={current}
					placeholder="/api/*"
					spellcheck="false"
					aria-label="Path prefix"
					onchange={setPath}
				/>
			</span>
		{:else if mode === 'named' && known && ongoto && current}
			<button class="fp-btn fp-btn--quiet" type="button" onclick={() => ongoto(current)}
				>Edit {current}</button
			>
		{/if}
	</div>
	{#if mode === 'path'}
		<p class="t-caption t-muted">
			A path matcher: <code>/api/*</code> matches everything under /api. Exact paths need no star.
		</p>
	{:else if mode === 'named' && !known}
		<p class="t-caption slot__warn">No <code>{current}</code> is defined in this block.</p>
	{/if}
</div>

<style>
	.slot {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.slot__label {
		font-weight: 500;
	}
	.slot__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.slot__path {
		flex: 1;
		min-width: 10rem;
	}
	.slot__path input {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.slot__warn {
		color: var(--warning-ink);
	}
</style>
