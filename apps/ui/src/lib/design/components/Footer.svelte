<script lang="ts">
	type Props = { version: string; timeZone: string };
	let { version, timeZone }: Props = $props();
</script>

<footer class="fp-footer">
	<span>Caddy UI {version}</span>
	<span>Times in {timeZone}</span>
</footer>
