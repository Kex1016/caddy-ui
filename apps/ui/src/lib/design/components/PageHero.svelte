<script lang="ts">
	type Props = { kicker?: string; title: string; lede?: string };
	let { kicker, title, lede }: Props = $props();
</script>

<header class="fp-hero">
	{#if kicker}<span class="t-kicker">{kicker}</span>{/if}
	<h1 class="t-title-1">{title}</h1>
	{#if lede}<p class="fp-lede t-body">{lede}</p>{/if}
</header>
