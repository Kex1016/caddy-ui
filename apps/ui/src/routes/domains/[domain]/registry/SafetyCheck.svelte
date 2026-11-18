<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import type { ApiError, Cached, Preflight, PreflightIntent } from '$lib/api/porkbun';
	import { AsOf } from '$lib/design/components';
	import { PorkbunNotice } from '$lib/porkbun/components';
	import PreflightChecks from '$lib/porkbun/registry/PreflightChecks.svelte';
	import { call, domainApi } from '$lib/porkbun/registry/api';

	/** Porkbun's safety check on demand (docs/porkbun-plan.md §2, "DNS safety check"). Read-only. */
	type Props = { domain: string; timeZone: string };
	let { domain, timeZone }: Props = $props();

	const INTENTS: { value: PreflightIntent; label: string }[] = [
		{ value: 'general', label: 'In general' },
		{ value: 'move-nameservers', label: 'Before changing nameservers' },
		{ value: 'enable-dnssec', label: 'Before turning on DNSSEC' },
		{ value: 'transfer-out', label: 'Before a transfer away' }
	];

	let intent = $state<PreflightIntent>('general');
	let running = $state(false);
	let result = $state<Cached<Preflight> | null>(null);
	let error = $state<ApiError | null>(null);

	async function run() {
		running = true;
		error = null;
		const answer = await call<Cached<Preflight>>(
			'GET',
			`${domainApi(domain, 'preflight')}?${new URLSearchParams({ intent, force: '1' })}`
		);
		running = false;
		if (answer.ok) result = answer.data;
		else {
			result = null;
			error = answer.error;
		}
	}
</script>

<section class="fp-section" aria-labelledby="safety-title">
	<div class="fp-section__head">
		<h2 class="t-title-2" id="safety-title">Safety check</h2>
		{#if result}<AsOf at={result.fetchedAt} {timeZone} stale={result.stale} />{/if}
	</div>
	<p class="fp-lede">
		Porkbun looks at the zone and the registry for things a change would break, such as DNSSEC that would no
		longer match. Nameserver and DNSSEC changes below run this check by themselves and are refused while it
		finds a blocker.
	</p>
	<div class="row">
		<label class="t-ui" for="pf-intent">Check</label>
		<span class="fp-select">
			<select id="pf-intent" bind:value={intent}>
				{#each INTENTS as i (i.value)}<option value={i.value}>{i.label}</option>{/each}
			</select>
			<ChevronDown class="fp-ico fp-ico--sm" aria-hidden="true" />
		</span>
		<button class="fp-btn" type="button" onclick={run} disabled={running}
			>{running ? 'Checking…' : 'Run check'}</button
		>
	</div>
	<div class="fp-panel out" aria-live="polite">
		{#if error}
			<PorkbunNotice {error} />
		{:else if result}
			<PreflightChecks preflight={result.data} />
		{:else}
			<p class="t-ui t-muted">Not run yet.</p>
		{/if}
	</div>
</section>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}
	.out {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
	}
</style>
