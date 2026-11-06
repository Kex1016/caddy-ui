<script lang="ts">
	import type { NavItem } from '$lib/nav';

	type Props = { label?: string; items: NavItem[]; current: string };
	let { label, items, current }: Props = $props();

	function isCurrent(href: string): boolean {
		return href === '/' ? current === '/' : current === href || current.startsWith(href + '/');
	}
</script>

<nav class="fp-nav-group" aria-label={label ?? 'Main'}>
	{#if label}<span class="fp-nav-group__label">{label}</span>{/if}
	{#each items as item (item.href)}
		<a
			class="fp-nav"
			href={item.href}
			title={item.label}
			aria-current={isCurrent(item.href) ? 'page' : undefined}
		>
			<item.icon class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
			<span class="fp-nav__label">{item.label}</span>
		</a>
	{/each}
</nav>
