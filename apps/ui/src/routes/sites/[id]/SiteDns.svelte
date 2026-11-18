<script lang="ts">
	import { onMount } from 'svelte';
	import type { SiteDnsCheck } from '$lib/api/porkbun-caddy';
	import { AsOf, Notice } from '$lib/design/components';
	import { Dns01Dialog, DnsChecks, RecordFixDialog, TieInState } from '$lib/porkbun/caddy';
	import { PorkbunNotice } from '$lib/porkbun/components';

	/**
	 * The site page's DNS panel (docs/porkbun-plan.md §4): for each of the site's names under a Porkbun domain,
	 * which record answers and whether it points at this server, with the one-step fix and the wildcard hint.
	 * Asked for after the page has rendered; draws nothing for a site that has nothing to do with Porkbun.
	 */
	type Props = {
		siteId: string;
		addresses: string[];
		timeZone: string;
		/** The answer of this page's `dns01` action. */
		form: { ok?: boolean; message?: string } | null;
	};
	let { siteId, addresses, timeZone, form }: Props = $props();

	const dns = new TieInState();
	onMount(() => void dns.load());

	const checks = $derived(dns.of(siteId).filter((c) => c.status !== 'not_porkbun' || c.hints.length > 0));
	let fixing = $state<SiteDnsCheck | null>(null);
	let adding = $state(false);
	const failed = $derived(form?.message && !form.ok ? form.message : null);
</script>

{#if checks.length > 0 || dns.error || form?.message}
	<section class="fp-section" id="dns">
		<div class="fp-section__head">
			<h2 class="t-title-2">DNS at Porkbun</h2>
			{#if dns.tie}<AsOf at={dns.tie.asOf} {timeZone} stale={dns.tie.stale} />{/if}
		</div>
		{#if form?.message && !adding}
			<Notice kind={form.ok ? 'success' : 'error'}>{form.message}</Notice>
		{/if}
		{#if dns.error}<PorkbunNotice error={dns.error} />{/if}
		{#if checks.length > 0}
			<div class="fp-panel">
				<DnsChecks
					{checks}
					gate={dns.gate}
					onfix={(c) => (fixing = c)}
					ondns01={() => (adding = true)}
					linkDomains
				/>
			</div>
		{/if}
	</section>
{/if}

<RecordFixDialog check={fixing} ondone={() => void dns.load()} onclose={() => (fixing = null)} />

<Dns01Dialog
	site={adding ? { id: siteId, addresses } : null}
	action="?/dns01"
	pluginUnknown={dns.tie?.plugin.state === 'unknown'}
	error={adding ? failed : null}
	onclose={() => (adding = false)}
	onresult={() => void dns.load()}
/>
