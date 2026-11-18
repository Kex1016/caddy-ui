<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { ApiError, DryRun } from '$lib/api/porkbun';
	import type { ChallengeRecord, SiteDnsCheck } from '$lib/api/porkbun-caddy';
	import { AsOf, EmptyState, Notice, Tag } from '$lib/design/components';
	import { formatDateTime, formatNumber } from '$lib/format';
	import { DnsChecks, RecordFixDialog } from '$lib/porkbun/caddy';
	import { cleanChallenges, getTieIn, previewCleanup } from '$lib/porkbun/caddy/api';
	import { PorkbunNotice, RecordValue, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import { domainHref } from '$lib/porkbun/tabs';
	import type { ReviewChange } from '$lib/porkbun/types';

	let { data } = $props();

	const tie = $derived(data.tie);
	const name = $derived(data.domain?.domain ?? '');
	const zone = $derived(tie?.domains.find((d) => d.domain === name) ?? null);
	const sites = $derived(tie?.sites ?? []);
	const challenges = $derived(tie?.challenges ?? []);
	const stale = $derived(challenges.filter((c) => c.stale));
	const dns01 = $derived(sites.filter((s) => s.dns01));
	const siteBlocks = $derived(new Set(sites.map((s) => s.siteId)).size);

	let checking = $state(false);
	async function again() {
		checking = true;
		// Asks Porkbun and Caddy again; the page then reads what that left in the cache.
		await getTieIn({ domain: name, force: true });
		await invalidateAll();
		checking = false;
	}

	// The review step for one site's record.
	let fixing = $state<SiteDnsCheck | null>(null);

	// The review step for challenge records that were left behind.
	let cleaning = $state(false);
	let cleanIds = $state<string[]>([]);
	let cleanDryRun = $state<DryRun | 'running' | null>(null);
	let cleanError = $state<ApiError | null>(null);
	let cleanBlocked = $state<string | null>(null);
	let cleanBusy = $state(false);
	let cleaned = $state<string | null>(null);
	let run = 0;

	const cleanChanges = $derived<ReviewChange[]>(
		stale
			.filter((c) => cleanIds.includes(c.id))
			.map((c) => ({
				kind: 'delete',
				title: `TXT ${c.name}`,
				before: c.content,
				note:
					c.sites.length > 0
						? `For the certificate of ${c.sites.join(', ')}. First seen ${formatDateTime(c.firstSeen, data.timeZone)}.`
						: `No site in the Caddyfile uses this name. First seen ${formatDateTime(c.firstSeen, data.timeZone)}.`
			}))
	);

	async function review(records: ChallengeRecord[]) {
		const mine = ++run;
		cleanIds = records.map((c) => c.id);
		cleanError = null;
		cleanBlocked = null;
		cleaned = null;
		cleanDryRun = 'running';
		cleaning = true;
		const res = await previewCleanup(name, cleanIds);
		if (mine !== run) return;
		if (res.ok) cleanDryRun = res.data.dryRun;
		else {
			cleanDryRun = null;
			cleanBlocked = res.error.message;
		}
	}

	async function clean() {
		cleanBusy = true;
		cleanError = null;
		const res = await cleanChallenges(name, cleanIds);
		cleanBusy = false;
		if (!res.ok) {
			cleanError = res.error;
			return;
		}
		const failed = res.data.results.filter((r) => !r.result.ok);
		const done = res.data.results.length - failed.length;
		await invalidateAll();
		if (failed.length > 0) {
			const first = failed[0]?.result;
			cleanError = first && !first.ok ? first.error : null;
			cleanIds = failed.map((r) => r.id);
			return;
		}
		cleaned = `Deleted ${formatNumber(done)} challenge ${done === 1 ? 'record' : 'records'}. The change is in the activity log.`;
		cleaning = false;
	}
</script>

<section class="fp-section">
	<div class="fp-section__head">
		<h2 class="t-title-2">Caddy</h2>
		<div class="asof">
			{#if tie}<AsOf at={tie.asOf} timeZone={data.timeZone} stale={tie.stale} />{/if}
			<button type="button" class="fp-btn" disabled={checking} onclick={again}>
				{checking ? 'Checking…' : 'Check again'}
			</button>
		</div>
	</div>
	<p class="t-body t-muted lede">
		How the sites in the Caddyfile and the records of {name} fit together: which names point at this server, and
		whether Caddy can get certificates through the DNS challenge.
	</p>
	{#if data.tieError}<PorkbunNotice error={data.tieError} />{/if}
	{#if tie?.caddyfileError}
		<Notice kind="warning"><b>The Caddyfile could not be read.</b> {tie.caddyfileError}</Notice>
	{/if}
</section>

{#if tie}
	<section class="fp-section">
		<div class="fp-section__head">
			<h3 class="t-title-3">DNS challenge</h3>
		</div>
		<div class="fp-panel facts">
			<div class="fact">
				<p class="fact__head">
					<span class="t-ui">Porkbun plugin</span>
					{#if tie.plugin.state === 'present'}
						<Tag kind="success">In the running Caddy</Tag>
					{:else if tie.plugin.state === 'missing'}
						<Tag kind="error">Not in the running Caddy</Tag>
					{:else}
						<Tag>Not checked</Tag>
					{/if}
				</p>
				{#if tie.plugin.state === 'present'}
					<p class="t-ui t-muted">
						Caddy can create the <code>_acme-challenge</code> records it needs, which is what a wildcard certificate
						takes.
					</p>
				{:else if tie.plugin.state === 'missing'}
					<p class="t-ui t-muted">
						The running Caddy was built without <code>{tie.plugin.module}</code>, so it refuses a Caddyfile
						that uses <code>dns porkbun</code>. Build Caddy with
						<code>xcaddy build --with github.com/caddy-dns/porkbun</code>; the repository's
						<code>deploy/caddy/Dockerfile</code> does that.
					</p>
				{:else}
					<p class="t-ui t-muted">
						Caddy could not be asked{tie.plugin.reason ? `: ${tie.plugin.reason}` : '.'}
					</p>
				{/if}
			</div>
			<div class="fact">
				<p class="fact__head">
					<span class="t-ui">Sites that use it</span>
					<span class="t-mono">{formatNumber(dns01.length)} of {formatNumber(sites.length)}</span>
				</p>
				<p class="t-ui t-muted">
					{#if tie.globalDns01}
						The global option <code>acme_dns {tie.globalDns01.provider ?? ''}</code> sets it for every site.
						<a href="/globals">Open global options</a>
					{:else if sites.length === 0}
						No site address is under this domain.
					{:else}
						Addresses under this domain whose site gets its certificate through the DNS challenge. It is set
						per site in its <code>tls</code> block, or for all sites with <code>acme_dns</code> in the
						<a href="/globals">global options</a>.
					{/if}
				</p>
			</div>
		</div>
		{#if zone?.servedByPorkbun === false}
			<Notice kind="warning">
				<b>{name} is served by other nameservers</b> ({(zone.nameservers ?? []).join(', ')}). The records at
				Porkbun are not what visitors get, and a certificate authority will not see a challenge record Caddy
				creates here. Nameservers are on the <a href={domainHref(name, 'registry')}>Registry tab</a>.
			</Notice>
		{/if}
		{#if zone?.error && zone.apiAccess}<PorkbunNotice error={zone.error} />{/if}
	</section>

	<section class="fp-section">
		<div class="fp-section__head">
			<h3 class="t-title-3">Sites under this domain</h3>
			<span class="t-caption t-faint">
				{formatNumber(sites.length)}
				{sites.length === 1 ? 'address' : 'addresses'} in {formatNumber(siteBlocks)}
				{siteBlocks === 1 ? 'site' : 'sites'}{tie.publicIp ? ` · this server is ${tie.publicIp}` : ''}
			</span>
		</div>
		{#if sites.length === 0}
			<EmptyState
				title="No site uses this domain"
				line="No site block in the Caddyfile has an address under {name}. Add one on the Sites page and it is checked here."
			/>
		{:else}
			<div class="fp-panel">
				<DnsChecks checks={sites} gate={data.porkbun} onfix={(c) => (fixing = c)} linkSites />
			</div>
		{/if}
	</section>

	<section class="fp-section">
		<div class="fp-section__head">
			<h3 class="t-title-3">Challenge records</h3>
			{#if stale.length > 0}
				<ScopeGate status={data.porkbun} scope="dns">
					{#snippet children({ disabled })}
						<button type="button" class="fp-btn" {disabled} onclick={() => review(stale)}>
							Clean up {formatNumber(stale.length)} left behind
						</button>
					{/snippet}
				</ScopeGate>
			{/if}
		</div>
		<p class="t-ui t-muted lede">
			For a certificate order Caddy creates a TXT record named <code>_acme-challenge</code> and deletes it when
			the order is done, usually within minutes. One that is still here a day after this UI first saw it was left
			behind and can be deleted.
		</p>
		{#if cleaned}<Notice kind="success">{cleaned}</Notice>{/if}
		{#if challenges.length === 0}
			<EmptyState
				title="No challenge records"
				line="Nothing named _acme-challenge is in the zone right now, which is the normal state between certificate orders."
			/>
		{:else}
			<div class="fp-panel fp-table__wrap">
				<table class="fp-table">
					<caption class="visually-hidden">Challenge records of {name}</caption>
					<thead>
						<tr>
							<th scope="col">Name</th>
							<th scope="col">Value</th>
							<th scope="col">For</th>
							<th scope="col">First seen</th>
							<th scope="col">State</th>
						</tr>
					</thead>
					<tbody>
						{#each challenges as c (c.id)}
							<tr>
								<td class="t-mono rname">{c.name}</td>
								<td class="value"><RecordValue type="TXT" content={c.content} clip /></td>
								<td class="t-ui">
									{#if c.sites.length > 0}{c.sites.join(', ')}{:else}<span class="t-faint">no site</span>{/if}
								</td>
								<td class="t-ui">{formatDateTime(c.firstSeen, data.timeZone)}</td>
								<td>
									<span class="tags">
										<Tag kind="acc">managed by Caddy</Tag>
										{#if c.stale}<Tag kind="warning">left behind</Tag>{/if}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}

<RecordFixDialog check={fixing} ondone={() => void invalidateAll()} onclose={() => (fixing = null)} />

<ReviewDialog
	bind:open={cleaning}
	title="Delete challenge records left behind"
	intro="These records were for certificate orders that are long over. Deleting them does not affect any certificate Caddy holds. Caddy creates new ones when it needs them."
	changes={cleanChanges}
	dryRun={cleanDryRun}
	blocked={cleanBlocked}
	busy={cleanBusy}
	error={cleanError}
	destructive
	applyLabel={cleanChanges.length === 1 ? 'Delete the record' : `Delete ${cleanChanges.length} records`}
	onapply={clean}
	oncancel={() => run++}
/>

<style>
	.asof {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-4);
	}
	.lede {
		max-width: 80ch;
	}
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
		gap: var(--space-5) var(--space-6);
	}
	.fact {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.fact__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		font-weight: 500;
	}
	.rname {
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.value {
		max-width: 280px;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-2);
	}
</style>
