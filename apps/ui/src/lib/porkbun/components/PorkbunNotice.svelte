<script lang="ts">
	import type { ApiError } from '$lib/api/porkbun';
	import { Notice } from '$lib/design/components';
	import { explain } from '$lib/porkbun/messages';

	/**
	 * An error from Porkbun (or from this UI's Porkbun module) and any advisory warnings, in Fishnet notices.
	 * Porkbun's message, hint and warnings are shown as written; the title and the fix come from messages.ts.
	 */
	type Props = { error?: ApiError | null; warnings?: readonly string[] };
	let { error = null, warnings = [] }: Props = $props();

	const info = $derived(error ? explain(error) : null);
	const link = $derived(error?.url ?? info?.url);
</script>

{#if error && info}
	<Notice kind={error.retryable ? 'warning' : 'error'}>
		<p><b>{info.title}</b> {error.message}</p>
		{#if error.hint}<p>{error.hint}</p>{/if}
		{#if info.fix}<p>{info.fix}</p>{/if}
		{#if error.retryAfter}<p>Porkbun asks to wait {error.retryAfter} s before trying again.</p>{/if}
		{#if link || error.requestId}
			<p class="meta">
				{#if link}<a href={link} target="_blank" rel="noopener noreferrer">Open at Porkbun</a>{/if}
				{#if error.requestId}<span class="t-caption">request {error.requestId}</span>{/if}
			</p>
		{/if}
	</Notice>
{/if}
{#each warnings as warning, i (i)}
	<Notice kind="warning"><p>{warning}</p></Notice>
{/each}

<style>
	p + p {
		margin-top: var(--space-1);
	}
	p {
		overflow-wrap: anywhere;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		align-items: baseline;
	}
</style>
