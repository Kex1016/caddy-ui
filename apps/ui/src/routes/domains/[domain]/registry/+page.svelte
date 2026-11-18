<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { call, domainApi } from '$lib/porkbun/registry/api';
	import { isAtPorkbun } from '$lib/porkbun/registry/validate';
	import DnssecSection from './DnssecSection.svelte';
	import GlueSection from './GlueSection.svelte';
	import NameserversSection from './NameserversSection.svelte';
	import SafetyCheck from './SafetyCheck.svelte';

	let { data } = $props();
	const domain = $derived(data.domain?.domain ?? '');
	const atPorkbun = $derived(data.ns.value ? isAtPorkbun(data.ns.value.data) : null);

	let refreshing = $state(false);

	/** Ask Porkbun again for all three sections, then reload the page's data from the refreshed cache. */
	async function refresh() {
		refreshing = true;
		await Promise.all(
			['nameservers', 'glue', 'dnssec'].map((area) => call('GET', `${domainApi(domain, area)}?force`))
		);
		await invalidateAll();
		refreshing = false;
	}

	const changed = () => invalidateAll();
</script>

<div class="bar">
	<p class="t-ui t-muted">Settings held at the registry for {domain}, not in the DNS zone.</p>
	<button class="fp-btn fp-btn--quiet" type="button" onclick={refresh} disabled={refreshing}
		>{refreshing ? 'Refreshing…' : 'Refresh'}</button
	>
</div>

<NameserversSection
	{domain}
	status={data.porkbun}
	timeZone={data.timeZone}
	part={data.ns}
	onchanged={changed}
/>
<DnssecSection
	{domain}
	status={data.porkbun}
	timeZone={data.timeZone}
	part={data.dnssec}
	{atPorkbun}
	onchanged={changed}
/>
<GlueSection {domain} status={data.porkbun} timeZone={data.timeZone} part={data.glue} onchanged={changed} />
<SafetyCheck {domain} timeZone={data.timeZone} />

<style>
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}
</style>
