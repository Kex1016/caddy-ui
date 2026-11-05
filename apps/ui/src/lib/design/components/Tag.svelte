<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		kind?: 'neutral' | 'acc' | 'success' | 'warning' | 'error';
		class?: string;
		children: Snippet;
	};
	let { kind = 'neutral', class: extra = '', children }: Props = $props();
</script>

<span
	class="fp-tag {extra}"
	class:fp-tag--acc={kind === 'acc'}
	class:fp-tag--success={kind === 'success'}
	class:fp-tag--warning={kind === 'warning'}
	class:fp-tag--error={kind === 'error'}>{@render children()}</span
>
