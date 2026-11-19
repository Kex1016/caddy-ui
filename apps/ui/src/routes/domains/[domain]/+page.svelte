<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { RefreshCw } from '@lucide/svelte';
	import type { ApiError, AutoRenewResult, DomainSummary } from '$lib/api/porkbun';
	import { AsOf, EmptyState, Notice, StatTile, Tag } from '$lib/design/components';
	import { formatDate, formatDateTime, formatNumber } from '$lib/format';
	import { PorkbunNotice, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import {
		daysUntil,
		describeTypes,
		expiryState,
		formatCountdown,
		formatUsd,
		type Part
	} from '$lib/porkbun/domains';
	import { sendJson } from '$lib/porkbun/domains/http';
	import { domainHref } from '$lib/porkbun/tabs';

	let { data } = $props();

	const overview = $derived(data.overview);
	/** The registry's own answer where there is one, the account list's copy otherwise. */
	const d = $derived<DomainSummary | null>(
		overview?.detail.ok ? overview.detail.data : (data.domain ?? null)
	);
	const days = $derived(d ? daysUntil(d.expireDate, data.now) : null);
	const expiry = $derived(expiryState(days));
	const tz = $derived(data.timeZone);

	const at = (iso: string) => {
		const t = Date.parse(iso);
		return Number.isNaN(t) ? null : t;
	};

	/** The oldest of the reads on the page, so the readout never claims more freshness than the page has. */
	const asOf = $derived.by(() => {
		if (!overview) return null;
		const parts: Part<unknown>[] = [
			overview.detail,
			overview.nameservers,
			overview.dns,
			overview.history,
			overview.forwards,
			overview.glue,
			overview.dnssec
		];
		const ok = parts.filter((p): p is Extract<Part<unknown>, { ok: true }> => p.ok);
		if (ok.length === 0) return null;
		return { at: Math.min(...ok.map((p) => p.fetchedAt)), stale: ok.some((p) => p.stale) };
	});

	const why = (p: Part<unknown>) =>
		p.ok ? '' : p.error.code === 'API_ACCESS_DISABLED' ? 'API access is off' : p.error.message;
	const count = (p: Part<number>) => (p.ok ? formatNumber(p.data) : '—');

	let refreshing = $state(false);
	async function refresh() {
		if (!d) return;
		refreshing = true;
		await fetch(`/api/porkbun/domains/${encodeURIComponent(d.domain)}?force`).catch(() => null);
		await invalidateAll();
		refreshing = false;
	}

	// ── Auto-renew ──────────────────────────────────────────────────────────────────────────────────────
	let reviewing = $state(false);
	let busy = $state(false);
	let applyError = $state<ApiError | null>(null);
	let done = $state<string | null>(null);
	let warnings = $state<string[]>([]);

	async function apply() {
		if (!d) return;
		busy = true;
		applyError = null;
		const on = !d.autoRenew;
		const res = await sendJson<{ data: { results: AutoRenewResult[] }; warnings: string[] }>(
			'PUT',
			`/api/porkbun/domains/${encodeURIComponent(d.domain)}/auto-renew`,
			{ on }
		);
		busy = false;
		if (!res.ok) {
			applyError = res.error;
			return;
		}
		const mine = res.data.data.results[0];
		if (!mine?.ok) {
			applyError = {
				code: 'AUTO_RENEW_REFUSED',
				message: mine?.message || 'Porkbun did not change it.',
				retryable: false
			};
			return;
		}
		warnings = res.data.warnings;
		done = `Auto-renew is now ${on ? 'on' : 'off'}.`;
		reviewing = false;
		await invalidateAll();
	}

	const NS_LINE = {
		porkbun: "Porkbun's own nameservers. The DNS records on the DNS tab are what the world sees.",
		custom:
			'Nameservers outside Porkbun. The records on the DNS tab are kept at Porkbun but not served while these are in place.',
		mixed:
			"A mix of Porkbun's nameservers and others. Resolvers may get different answers depending on which one they ask.",
		none: 'Porkbun lists no nameservers for this domain.'
	} as const;
</script>

{#if data.overviewError}
	<section class="fp-section"><PorkbunNotice error={data.overviewError} /></section>
{:else if overview && d}
	{#if done}
		<section class="fp-section" aria-live="polite">
			<Notice kind="success">{done}</Notice>
			<PorkbunNotice {warnings} />
		</section>
	{/if}

	<section class="fp-section">
		<div class="head">
			<h2 class="t-title-2">At a glance</h2>
			<div class="asof">
				{#if asOf}<AsOf at={asOf.at} timeZone={tz} stale={asOf.stale} />{/if}
				<button class="fp-btn fp-btn--quiet" type="button" onclick={refresh} disabled={refreshing}>
					<RefreshCw class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
					{refreshing ? 'Refreshing…' : 'Refresh'}
				</button>
			</div>
		</div>
		<div class="fp-tiles glance">
			<StatTile
				label="DNS records"
				value={overview.dns.ok ? formatNumber(overview.dns.data.total) : '—'}
				note={overview.dns.ok
					? overview.dns.data.total === 0
						? 'No records yet'
						: describeTypes(overview.dns.data.byType)
					: why(overview.dns)}
				href={domainHref(d.domain, 'dns')}
			/>
			<StatTile
				label="Restore points"
				value={overview.history.ok ? formatNumber(overview.history.data.total) : '—'}
				note={overview.history.ok
					? overview.history.data.latest && at(overview.history.data.latest) !== null
						? `Latest ${formatDate(at(overview.history.data.latest) as number, tz)}`
						: 'None yet'
					: why(overview.history)}
				href={domainHref(d.domain, 'history')}
			/>
			<StatTile
				label="URL forwards"
				value={count(overview.forwards)}
				note={overview.forwards.ok ? 'Redirects Porkbun serves' : why(overview.forwards)}
				href={domainHref(d.domain, 'forwarding')}
			/>
			<StatTile
				label="Glue hosts"
				value={count(overview.glue)}
				note={overview.glue.ok ? 'Nameservers named under this domain' : why(overview.glue)}
				href={domainHref(d.domain, 'registry')}
			/>
			<StatTile
				label="DNSSEC"
				value={count(overview.dnssec)}
				note={overview.dnssec.ok
					? overview.dnssec.data === 0
						? 'Not signed at the registry'
						: `DS ${overview.dnssec.data === 1 ? 'record' : 'records'} at the registry`
					: why(overview.dnssec)}
				href={domainHref(d.domain, 'registry')}
			/>
		</div>
	</section>

	<div class="fp-two">
		<section class="fp-panel stack" aria-labelledby="reg">
			<h2 class="t-title-2" id="reg">Registration</h2>
			{#if !overview.detail.ok}
				<Notice kind="warning">
					<b>Porkbun's details for this domain could not be read,</b> so this shows the copy from the account
					list. {overview.detail.error.message}
				</Notice>
			{/if}
			<dl class="facts">
				<dt>Status</dt>
				<dd><Tag kind={d.status === 'ACTIVE' ? 'success' : 'warning'}>{d.status || 'unknown'}</Tag></dd>

				<dt>Registered</dt>
				<dd>{at(d.createDate) === null ? 'unknown' : formatDateTime(at(d.createDate) as number, tz)}</dd>

				<dt>Expires</dt>
				<dd>
					{#if at(d.expireDate) === null}unknown{:else}
						{formatDateTime(at(d.expireDate) as number, tz)}
						<Tag
							kind={expiry === 'expired'
								? 'error'
								: expiry === 'soon' && !d.autoRenew
									? 'warning'
									: 'neutral'}>{expiry === 'expired' ? 'expired' : formatCountdown(days)}</Tag
						>
					{/if}
				</dd>

				<dt>Auto-renew</dt>
				<dd class="renew">
					<span>
						{#if d.autoRenew}<Tag kind="success">on</Tag>{:else}<Tag>off</Tag>{/if}
						<span class="t-ui t-muted"
							>{d.autoRenew
								? 'Porkbun renews it from the account credit before it expires.'
								: 'It lapses at the expiry date unless renewed by hand.'}</span
						>
					</span>
					<ScopeGate status={data.porkbun} scope="domains">
						{#snippet children({ disabled })}
							<button
								class="fp-btn"
								type="button"
								disabled={disabled || !d.apiAccess}
								title={d.apiAccess ? undefined : 'Turn on API access for this domain first'}
								onclick={() => {
									applyError = null;
									reviewing = true;
								}}>Turn {d.autoRenew ? 'off' : 'on'}</button
							>
						{/snippet}
					</ScopeGate>
				</dd>

				<dt>Renewal price</dt>
				<dd>
					{#if overview.renewal}
						<span class="t-mono">{formatUsd(overview.renewal)}</span>
						<span class="t-ui t-muted">a year, Porkbun's list price for .{d.tld}</span>
					{:else if overview.pricingError}
						<span class="t-muted">Not available: {overview.pricingError.message}</span>
					{:else}
						<span class="t-muted">Not in Porkbun's price list</span>
					{/if}
				</dd>

				<dt>Transfer lock</dt>
				<dd>
					{#if d.securityLock}<Tag kind="success">on</Tag>{:else}<Tag kind="warning">off</Tag>
						<span class="t-ui t-muted">The domain can be transferred away.</span>{/if}
				</dd>

				<dt>WHOIS privacy</dt>
				<dd>
					{#if d.whoisPrivacy}<Tag kind="success">on</Tag>{:else}<Tag>off</Tag>
						<span class="t-ui t-muted">The registrant's details are public.</span>{/if}
				</dd>

				<dt>API access</dt>
				<dd>
					{#if d.apiAccess}<Tag kind="success">on</Tag>{:else}<Tag kind="error">off</Tag>{/if}
				</dd>

				{#if d.labels.length > 0}
					<dt>Labels</dt>
					<dd class="labels">
						{#each d.labels as l (l.id)}<Tag>{l.title}</Tag>{/each}
					</dd>
				{/if}
			</dl>
			<p class="t-caption">
				The transfer lock, WHOIS privacy and API access are changed at <a
					class="inline-link"
					href="https://porkbun.com/account/domainsSpeedy"
					target="_blank"
					rel="noopener noreferrer">porkbun.com</a
				>.
			</p>
		</section>

		<div class="side">
			<section class="fp-panel stack" aria-labelledby="ns">
				<h2 class="t-title-2" id="ns">Nameservers</h2>
				{#if overview.nameservers.ok}
					{@const ns = overview.nameservers.data}
					<p class="t-ui">
						<Tag kind={ns.kind === 'porkbun' ? 'success' : ns.kind === 'custom' ? 'neutral' : 'warning'}
							>{ns.kind === 'porkbun' ? 'Porkbun' : ns.kind === 'custom' ? 'elsewhere' : ns.kind}</Tag
						>
						{NS_LINE[ns.kind]}
					</p>
					{#if ns.ns.length > 0}
						<ul class="ns t-mono">
							{#each ns.ns as n (n)}<li>{n}</li>{/each}
						</ul>
					{/if}
				{:else}
					<p class="t-ui t-muted">Not available: {why(overview.nameservers)}.</p>
				{/if}
				{#if overview.dns.ok && overview.dns.data.cloudflare}
					<Notice>Porkbun's Cloudflare proxy is on for this domain.</Notice>
				{/if}
				<a class="fp-btn" href={domainHref(d.domain, 'registry')}>Nameservers, glue and DNSSEC</a>
			</section>

			<section class="fp-panel stack" aria-labelledby="recent">
				<h2 class="t-title-2" id="recent">Recent changes from here</h2>
				{#if data.recent.length === 0}
					<EmptyState
						title="No changes yet"
						line="Changes made to this domain from Caddy UI are listed here."
					/>
				{:else}
					<ul class="recent">
						{#each data.recent as e (e.id)}
							<li>
								<span class="t-mono">{e.action}</span>
								{#if e.ok}<Tag kind="success">applied</Tag>{:else}<Tag kind="error">failed</Tag>{/if}
								<span class="t-caption">{formatDateTime(e.ts, tz)} · {e.author}</span>
							</li>
						{/each}
					</ul>
				{/if}
				<a class="fp-btn" href="/domains/activity?domain={encodeURIComponent(d.domain)}"
					>All activity for {d.domain}</a
				>
			</section>
		</div>
	</div>

	<ReviewDialog
		bind:open={reviewing}
		title="Turn auto-renew {d.autoRenew ? 'off' : 'on'}"
		intro={d.autoRenew
			? `Porkbun will not renew ${d.domain}. It lapses at its expiry date unless it is renewed by hand.`
			: `Porkbun renews ${d.domain} from the account credit before it expires.`}
		changes={[
			{
				kind: 'edit',
				title: `Auto-renew for ${d.domain}`,
				before: d.autoRenew ? 'on' : 'off',
				after: d.autoRenew ? 'off' : 'on',
				...(overview.renewal
					? { note: `Renewal is ${formatUsd(overview.renewal)} a year at list price.` }
					: {})
			}
		]}
		applyLabel="Turn {d.autoRenew ? 'off' : 'on'}"
		{busy}
		error={applyError}
		onapply={apply}
	/>
{/if}

<style>
	/* Links inside a sentence need more than colour to stand out (WCAG 1.4.1). */
	.inline-link {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.glance {
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-4);
	}
	.asof {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}
	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-4);
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
	.facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--space-3) var(--space-5);
		margin: 0;
		width: 100%;
	}
	.facts dt {
		font: 500 14px/20px var(--font-text);
		color: var(--muted);
	}
	.facts dd {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.renew {
		justify-content: space-between;
	}
	.renew > span {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	.labels {
		gap: var(--space-1);
	}
	.ns,
	.recent {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 13px;
	}
	.recent li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	@media (max-width: 640px) {
		.facts {
			grid-template-columns: 1fr;
			gap: var(--space-1);
		}
		.facts dd {
			margin-bottom: var(--space-3);
		}
	}
</style>
