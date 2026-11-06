<script lang="ts">
	import { CircleAlert, CircleCheck, Info, TriangleAlert } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	type Props = { kind?: 'info' | 'success' | 'warning' | 'error'; children: Snippet };
	let { kind = 'info', children }: Props = $props();
	const Icon = $derived(
		kind === 'warning'
			? TriangleAlert
			: kind === 'error'
				? CircleAlert
				: kind === 'success'
					? CircleCheck
					: Info
	);
</script>

<div
	class="fp-notice"
	class:fp-notice--warning={kind === 'warning'}
	class:fp-notice--error={kind === 'error'}
	class:fp-notice--success={kind === 'success'}
	role={kind === 'warning' || kind === 'error' ? 'alert' : 'status'}
>
	<Icon class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
	<div>{@render children()}</div>
</div>
