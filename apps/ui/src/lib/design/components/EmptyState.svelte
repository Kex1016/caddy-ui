<script lang="ts">
	import { Inbox } from '@lucide/svelte';
	import type { Component, Snippet } from 'svelte';

	type Props = { title: string; line?: string; since?: string; icon?: Component; children?: Snippet };
	let { title, line, since, icon, children }: Props = $props();
	const Icon = $derived(icon ?? Inbox);
</script>

<div class="fp-empty">
	<Icon class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
	<p class="fp-empty__title">{title}</p>
	{#if line}<p class="fp-empty__line">{line}</p>{/if}
	{#if since}<p class="fp-empty__since">{since}</p>{/if}
	{@render children?.()}
</div>
