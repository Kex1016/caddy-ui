<script lang="ts">
	import { ChartColumn, Table2 } from '@lucide/svelte';
	import { withParam } from './url';
	import type { View } from './types';

	/** The page's one "Charts | Tables" switch; it sits in the first chart section's head, never on a card. */
	type Props = { url: URL; view: View };
	let { url, view }: Props = $props();
</script>

<nav class="fp-seg" aria-label="Charts or tables">
	<a
		href={withParam(url, 'view', null)}
		aria-current={view === 'charts' ? 'true' : undefined}
		data-sveltekit-noscroll
		data-sveltekit-replacestate
		><ChartColumn class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />Charts</a
	>
	<a
		href={withParam(url, 'view', 'tables')}
		aria-current={view === 'tables' ? 'true' : undefined}
		data-sveltekit-noscroll
		data-sveltekit-replacestate
		><Table2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />Tables</a
	>
</nav>
