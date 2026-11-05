<script lang="ts">
	/** The Caddy UI mark beside the name. One colour (acc-ink) on the 24px grid at stroke 1.5, as Fishnet's
	 * Brand; the fish is Fishnet's own mark, so this app draws a padlocked page (a Caddyfile behind TLS). */
	type Props = { href?: string; name?: string };
	let { href = '/', name = 'Caddy UI' }: Props = $props();
</script>

<a class="fp-brand" {href}>
	<svg
		class="fp-brand__mark"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
		<path d="M14 3v4a1 1 0 0 0 1 1h4v3" />
		<path d="M14 3l5 5" />
		<rect x="13" y="15" width="8" height="6" rx="1.5" />
		<path d="M15 15v-1.5a2 2 0 0 1 4 0V15" />
	</svg>
	<span class="fp-brand__name">{name}</span>
</a>
