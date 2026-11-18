<script lang="ts">
	import type { Preflight } from '$lib/api/porkbun';
	import { Notice, Tag } from '$lib/design/components';

	/**
	 * The result of Porkbun's safety check (`/dns/preflight`), as written: each check with its severity, and
	 * what to do about the ones that failed. In review dialogs pass `onlyFailing` to leave the passed checks
	 * out and `summary={false}`, since the dialog says itself whether the change can be applied.
	 */
	type Props = { preflight: Preflight; onlyFailing?: boolean; summary?: boolean };
	let { preflight, onlyFailing = false, summary = true }: Props = $props();

	const failing = $derived(preflight.checks.filter((c) => !c.ok));
	const passed = $derived(preflight.checks.filter((c) => c.ok));
	const KIND = { blocker: 'error', warning: 'warning', info: 'neutral' } as const;
</script>

{#if !summary}
	<!-- the dialog around it says whether the change can be applied -->
{:else if preflight.blockers.length > 0}
	<Notice kind="error"
		><b>Porkbun's safety check found {preflight.blockers.length === 1 ? 'a blocker' : 'blockers'}.</b>
		Nameserver and DNSSEC changes are refused until {preflight.blockers.length === 1 ? 'it is' : 'they are'} fixed.</Notice
	>
{:else if preflight.safe}
	<Notice kind="success">Porkbun's safety check found no problems.</Notice>
{/if}

{#if failing.length > 0}
	<ul class="checks" aria-label="Problems found">
		{#each failing as check (check.id)}
			<li class="check">
				<p class="check__head">
					<Tag kind={KIND[check.severity]}>{check.severity}</Tag>
					<b>{check.title}</b>
				</p>
				{#if check.detail}<p class="t-ui t-muted">{check.detail}</p>{/if}
				{#if check.nextAction}<p class="t-ui">{check.nextAction}</p>{/if}
			</li>
		{/each}
	</ul>
{/if}
{#if !onlyFailing && passed.length > 0}
	<p class="t-ui t-muted">
		Also checked, no problem found: {passed.map((c) => c.title).join(' · ')}
	</p>
{/if}

<style>
	.checks {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.check {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.check__head {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
</style>
