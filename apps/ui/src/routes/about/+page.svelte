<script lang="ts">
	import { PageHero } from '$lib/design/components';
	import { formatDateTime } from '$lib/format';

	let { data } = $props();
</script>

<PageHero kicker="System" title="About" lede="The version of this UI and how long it has been running." />
<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">This instance</h2></div>
	<div class="fp-panel">
		<p class="t-body">
			Caddy UI <span class="t-mono">{data.version}</span>, running since {formatDateTime(
				data.startedAt,
				data.timeZone
			)}.
		</p>
		<p class="t-body t-muted">
			The configuration it runs with, and what can be changed without a restart, is in Settings.
		</p>
		<p><a class="fp-btn" href="/settings">Open Settings</a></p>
	</div>
</section>
