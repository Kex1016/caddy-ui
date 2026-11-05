<script lang="ts">
	export type Crumb = { label: string; href?: string };
	type Props = { items: Crumb[] };
	let { items }: Props = $props();
</script>

<nav class="fp-crumbs" aria-label="Breadcrumb">
	{#each items as item, i (i)}
		{#if i > 0}<span aria-hidden="true">/</span>{/if}
		{#if i === items.length - 1 || !item.href}
			<span aria-current={i === items.length - 1 ? 'page' : undefined}>{item.label}</span>
		{:else}
			<a href={item.href}>{item.label}</a>
		{/if}
	{/each}
</nav>
