<script lang="ts">
	import { PageHero } from '$lib/design/components';
	import EditorWorkbench from '$lib/visual/components/EditorWorkbench.svelte';

	let { data } = $props();
</script>

<PageHero
	kicker="Caddyfile"
	title="Editor"
	lede="Edit the Caddyfile as an outline with forms, or as text. Problems are marked as you go; Caddy checks the file again before anything is written, and you see the changes before they apply."
/>

{#key data.doc.hash}
	<EditorWorkbench doc={data.doc} timeZone={data.timeZone} sites={data.sites} initialMode={data.mode} />
{/key}
