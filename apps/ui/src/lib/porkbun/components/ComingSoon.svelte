<script lang="ts">
	import { Hammer } from '@lucide/svelte';
	import { EmptyState } from '$lib/design/components';

	/** The placeholder a tab shows until its workstream replaces the page. */
	type Props = { what: string };
	let { what }: Props = $props();
</script>

<section class="fp-section">
	<EmptyState
		icon={Hammer}
		title="{what} is not built yet"
		line="This part of the Domains area arrives in a later update of Caddy UI."
	/>
</section>
