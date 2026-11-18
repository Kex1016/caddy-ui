<script lang="ts">
	/**
	 * A DNS record's value in JetBrains Mono (docs/porkbun-plan.md §6), with the priority in front where the
	 * type has one. Long values (TXT, DKIM keys) wrap anywhere; `clip` keeps them to one line in tables, with
	 * the whole value in the tooltip.
	 */
	type Props = { type?: string; content: string; prio?: number | null; clip?: boolean };
	let { type = '', content, prio = null, clip = false }: Props = $props();

	const showPrio = $derived(prio !== null && (type === 'MX' || type === 'SRV'));
</script>

<span class="rv t-mono" class:rv--clip={clip} title={clip ? content : undefined}>
	{#if showPrio}<span class="rv__prio" title="Priority">{prio}</span>{/if}<span class="rv__text"
		>{content}</span
	>
</span>

<style>
	.rv {
		font-size: 13px;
		line-height: 20px;
		overflow-wrap: anywhere;
		font-variant-ligatures: none;
	}
	.rv__prio {
		color: var(--muted);
		margin-right: var(--space-2);
	}
	.rv--clip {
		display: inline-block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		vertical-align: bottom;
	}
</style>
