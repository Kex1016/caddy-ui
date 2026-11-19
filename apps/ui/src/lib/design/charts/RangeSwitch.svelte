<script lang="ts">
	import type { RangeKey } from './types';
	import { withParam } from './url';

	/** The time range for every chart on the page, as links that keep the other query parameters. The saved default range has no parameter. */
	type Props = { url: URL; range: RangeKey; defaultRange?: RangeKey };
	let { url, range, defaultRange = '24h' }: Props = $props();
	const RANGES: { key: RangeKey; label: string }[] = [
		{ key: '1h', label: '1 hour' },
		{ key: '24h', label: '24 hours' },
		{ key: '7d', label: '7 days' },
		{ key: '30d', label: '30 days' }
	];
</script>

<nav class="fp-seg" aria-label="Time range">
	{#each RANGES as r (r.key)}
		<a
			href={withParam(url, 'range', r.key === defaultRange ? null : r.key)}
			aria-current={r.key === range ? 'true' : undefined}
			data-sveltekit-noscroll
			data-sveltekit-replacestate>{r.label}</a
		>
	{/each}
</nav>
