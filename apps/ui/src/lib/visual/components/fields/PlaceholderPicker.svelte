<script lang="ts">
	import { Braces, Search } from '@lucide/svelte';
	type PlaceholderChoice = { name: string; doc: string; group?: string };

	type Props = { choices: readonly PlaceholderChoice[]; oninsert: (name: string) => void; label?: string };
	let { choices, oninsert, label = 'Insert a placeholder' }: Props = $props();

	let open = $state(false);
	let query = $state('');
	let root: HTMLDivElement | undefined = $state();

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = q
			? choices.filter((c) => c.name.toLowerCase().includes(q) || c.doc.toLowerCase().includes(q))
			: choices;
		const groups: { group: string; items: PlaceholderChoice[] }[] = [];
		for (const c of list.slice(0, 120)) {
			const name = c.group ?? 'Placeholders';
			const g = groups.find((x) => x.group === name);
			if (g) g.items.push(c);
			else groups.push({ group: name, items: [c] });
		}
		return groups;
	});

	function pick(name: string) {
		oninsert(name);
		open = false;
		query = '';
	}

	$effect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => {
			if (root && !root.contains(e.target as Node)) open = false;
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape') open = false;
		};
		document.addEventListener('mousedown', close);
		document.addEventListener('keydown', key);
		return () => {
			document.removeEventListener('mousedown', close);
			document.removeEventListener('keydown', key);
		};
	});
</script>

<div class="pp" bind:this={root}>
	<button
		class="fp-ibtn pp__btn"
		type="button"
		aria-label={label}
		title={label}
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<Braces class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
	</button>
	{#if open}
		<div class="pp__pop fp-rise" role="dialog" aria-label="Placeholders">
			<label class="fp-field pp__search">
				<Search class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
				<!-- svelte-ignore a11y_autofocus -->
				<input type="search" placeholder="Search placeholders" bind:value={query} autofocus />
			</label>
			<div class="pp__list">
				{#each shown as g (g.group)}
					<p class="t-kicker pp__group">{g.group}</p>
					{#each g.items as c (c.name)}
						<button type="button" class="pp__item" onclick={() => pick(c.name)}>
							<code>{c.name}</code>
							<span class="t-caption">{c.doc}</span>
						</button>
					{/each}
				{:else}
					<p class="t-ui t-muted pp__none">No placeholder matches.</p>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.pp {
		position: relative;
		flex: none;
	}
	.pp__btn {
		width: 28px;
		height: 28px;
	}
	.pp__pop {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 20;
		width: min(360px, 80vw);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-float);
	}
	.pp__search {
		width: 100%;
	}
	.pp__list {
		max-height: 300px;
		overflow: auto;
		display: flex;
		flex-direction: column;
	}
	.pp__group {
		font-size: 11px;
		padding: var(--space-2) var(--space-2) var(--space-1);
	}
	.pp__item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: var(--space-1) var(--space-2);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	.pp__item:hover {
		background: var(--hover-tint, var(--raised));
	}
	.pp__item code {
		background: transparent;
		padding: 0;
		color: var(--success-ink);
	}
	.pp__item span {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.pp__none {
		padding: var(--space-2);
	}
</style>
