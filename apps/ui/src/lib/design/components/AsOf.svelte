<script lang="ts">
	import { formatDateTime } from '$lib/format';

	/** "as of 4 Nov 2026, 17:44 CET", or "last good data as of …" when the source could not be reached. */
	type Props = { at: number; timeZone: string; stale?: boolean };
	let { at, timeZone, stale = false }: Props = $props();
</script>

<time class="fp-asof" datetime={new Date(at).toISOString()}
	>{stale ? 'last good data as of' : 'as of'} {formatDateTime(at, timeZone)}</time
>
