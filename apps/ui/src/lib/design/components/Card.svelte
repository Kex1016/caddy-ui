<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		title?: string;
		href?: string;
		sub?: string;
		readout?: Snippet;
		foot?: Snippet;
		children: Snippet;
	};
	let { title, href, sub, readout, foot, children }: Props = $props();
</script>

<section class="fp-card">
	{#if title || readout}
		<header class="fp-card__head">
			<div>
				{#if title}
					<h3 class="fp-card__title">
						{#if href}<a {href}>{title}</a>{:else}{title}{/if}
					</h3>
				{/if}
				{#if sub}<p class="fp-card__sub">{sub}</p>{/if}
			</div>
			{#if readout}<div class="fp-card__readout">{@render readout()}</div>{/if}
		</header>
	{/if}
	<div class="fp-card__body">{@render children()}</div>
	{#if foot}<footer class="fp-card__foot">{@render foot()}</footer>{/if}
</section>
