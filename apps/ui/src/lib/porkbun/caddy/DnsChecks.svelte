<script lang="ts">
	import type { PorkbunStatus } from '$lib/api/porkbun';
	import type { SiteDnsCheck } from '$lib/api/porkbun-caddy';
	import { Notice, Tag } from '$lib/design/components';
	import { RecordValue, ScopeGate } from '$lib/porkbun/components';
	import { domainHref } from '$lib/porkbun/tabs';
	import DnsStatusTag from './DnsStatusTag.svelte';

	/**
	 * The cross-check of site addresses against the records at Porkbun (docs/porkbun-plan.md §4), one entry
	 * per address: what was found, the records the name resolves through, what is wrong with the DNS challenge
	 * if anything, and the one change that would fix it. The buttons only open a review step.
	 */
	type Props = {
		checks: readonly SiteDnsCheck[];
		gate: Pick<PorkbunStatus, 'state' | 'readonly' | 'scopes'>;
		onfix: (check: SiteDnsCheck) => void;
		/** Offer the Porkbun DNS challenge for a wildcard site. Leave out where the page can not apply it. */
		ondns01?: (check: SiteDnsCheck) => void;
		/** Link each address to its site page (on the domain's Caddy tab). */
		linkSites?: boolean;
		/** Link to the domain's DNS tab (on the Sites pages). */
		linkDomains?: boolean;
	};
	let { checks, gate, onfix, ondns01, linkSites = false, linkDomains = false }: Props = $props();

	const challenge = (c: SiteDnsCheck) =>
		c.dns01Detail?.provider
			? `DNS challenge: ${c.dns01Detail.provider}${c.dns01Detail.source === 'global' ? ' (global)' : ''}`
			: 'DNS challenge';
</script>

<ul class="checks">
	{#each checks as c (c.siteId + c.host)}
		<li class="check">
			<p class="check__head">
				{#if linkSites}
					<a class="t-mono check__name" href="/sites/{c.siteId}">{c.host}</a>
				{:else}
					<span class="t-mono check__name">{c.host}</span>
				{/if}
				<DnsStatusTag check={c} />
				{#if c.dns01}<Tag kind="acc">{challenge(c)}</Tag>{/if}
			</p>
			<p class="t-ui check__detail">{c.detail}</p>
			{#if c.records.length > 0}
				<ul class="check__records" aria-label="Records {c.host} resolves through">
					{#each c.records as r (r.id)}
						<li class="t-ui">
							<span class="fp-tag">{r.type}</span>
							<span class="t-mono check__rname">{r.name}</span>
							<span class="t-faint" aria-hidden="true">→</span>
							<RecordValue type={r.type} content={r.content} />
						</li>
					{/each}
				</ul>
			{/if}
			{#each c.hints as hint (hint.code)}
				<Notice kind={hint.severity === 'warning' ? 'warning' : 'info'}>
					<p>{hint.message}</p>
					{#if hint.canAddPorkbun && ondns01}
						<p class="check__act">
							<button type="button" class="fp-btn" onclick={() => ondns01(c)}
								>Use the Porkbun DNS challenge</button
							>
						</p>
					{/if}
				</Notice>
			{/each}
			{#if c.fix || (linkDomains && c.domain)}
				<p class="check__foot">
					{#if c.fix}
						<ScopeGate status={gate} scope="dns">
							{#snippet children({ disabled })}
								<button type="button" class="fp-btn fp-btn--primary" {disabled} onclick={() => onfix(c)}>
									{c.fix?.kind === 'edit' ? 'Point it at this server' : 'Create the record'}
								</button>
							{/snippet}
						</ScopeGate>
					{/if}
					{#if linkDomains && c.domain}
						<a class="t-ui" href={domainHref(c.domain, 'dns')}>DNS records of {c.domain}</a>
					{/if}
				</p>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.checks {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.check {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4) 0;
		border-top: 1px solid var(--line-soft);
	}
	.check:first-child {
		border-top: 0;
		padding-top: 0;
	}
	.check:last-child {
		padding-bottom: 0;
	}
	.check__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.check__name {
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.check__detail {
		color: var(--muted);
		max-width: 80ch;
	}
	.check__records {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.check__records li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
	}
	.check__rname {
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.check__act {
		margin-top: var(--space-2);
	}
	.check__foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-4);
	}
</style>
