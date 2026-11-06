<script lang="ts">
	import { PageHero } from '$lib/design/components';
	import EditorWorkbench from '$lib/visual/components/EditorWorkbench.svelte';

	let { data } = $props();
</script>

<PageHero
	kicker="Caddyfile"
	title="Globals"
	lede="Global options, snippets and named routes: the blocks of the Caddyfile that are not sites. Text mode shows the whole file."
/>

{#key data.doc.hash}
	<EditorWorkbench doc={data.doc} timeZone={data.timeZone} scope="globals" initialMode={data.mode} />
{/key}
