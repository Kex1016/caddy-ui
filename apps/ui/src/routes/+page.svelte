<script lang="ts">
	import { EmptyState, PageHero } from '$lib/design/components';
</script>

<PageHero
	kicker="Server"
	title="Overview"
	lede="Requests, errors, latency and uptime for the whole Caddy server."
/>
<section class="fp-section">
	<EmptyState
		title="Nothing recorded yet"
		line="Server tiles and charts appear here once the collector is running."
	/>
</section>
