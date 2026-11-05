<script lang="ts">
	import { EmptyState, PageHero } from '$lib/design/components';
</script>

<PageHero
	kicker="System"
	title="Settings"
	lede="Sign-in, probe and scrape intervals, and helpers to turn on Caddy metrics and access logs."
/>
<section class="fp-section">
	<EmptyState
		title="No settings yet"
		line="Settings that can change at runtime appear here. Everything else comes from environment variables."
	/>
</section>
