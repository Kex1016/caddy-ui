<script lang="ts">
	import { invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, Search } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { ApiError } from '$lib/api/porkbun';
	import { AsOf, EmptyState, Notice, PageHero, Tag } from '$lib/design/components';
	import { formatDate, formatDateTime, formatNumber } from '$lib/format';
	import { PorkbunNotice, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import {
		DOMAIN_FILTERS,
		EXPIRING_SOON_DAYS,
		PAGE_SIZE,
		daysUntil,
		expiryState,
		formatCents,
		formatCountdown,
		formatUsd,
		isDomainFilter,
		matchesFilter,
		matchesQuery,
		sortDomains,
		type BulkAutoRenew,
		type DomainFilter,
		type ListRow,
		type DomainSort,
		type DomainSortKey
	} from '$lib/porkbun/domains';
	import { sendJson } from '$lib/porkbun/domains/http';
	import { domainHref } from '$lib/porkbun/tabs';
	import type { ReviewChange } from '$lib/porkbun/types';

	let { data } = $props();

	const rows = $derived<ListRow[]>(data.list?.data ?? []);
	const now = $derived(data.now);

	// ── Search, filter, sort, page ──────────────────────────────────────────────────────────────────────
	const initial = page.url.searchParams.get('filter');
	let filter = $state<DomainFilter>(isDomainFilter(initial) ? initial : 'all');
	let query = $state(page.url.searchParams.get('q') ?? '');
	let sort = $state<DomainSort>({ key: 'domain', dir: 'asc' });
	let pageIndex = $state(0);

	const counts = $derived.by(() => {
		const out = {} as Record<DomainFilter, number>;
		for (const f of DOMAIN_FILTERS) out[f.id] = rows.filter((r) => matchesFilter(r, f.id, now)).length;
		return out;
	});
	const shown = $derived(
		sortDomains(
			rows.filter((r) => matchesFilter(r, filter, now) && matchesQuery(r, query)),
			sort
		)
	);
	const pages = $derived(Math.max(1, Math.ceil(shown.length / PAGE_SIZE)));
	const current = $derived(Math.min(pageIndex, pages - 1));
	const visible = $derived(shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE));

	/** Keep the filter and search in the address, so a reload or a shared link shows the same list. */
	function remember() {
		const url = new URL(page.url);
		if (filter === 'all') url.searchParams.delete('filter');
		else url.searchParams.set('filter', filter);
		if (query.trim() === '') url.searchParams.delete('q');
		else url.searchParams.set('q', query.trim());
		replaceState(url, page.state);
	}
	function setFilter(f: DomainFilter) {
		filter = f;
		pageIndex = 0;
		remember();
	}
	function onSearch() {
		pageIndex = 0;
		remember();
	}
	function sortBy(key: DomainSortKey) {
		sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
		pageIndex = 0;
	}
	const ariaSort = (key: DomainSortKey) =>
		sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

	// ── Selection ───────────────────────────────────────────────────────────────────────────────────────
	const selected = new SvelteSet<string>();
	const selectedRows = $derived(rows.filter((r) => selected.has(r.domain)));
	const allShown = $derived(shown.length > 0 && shown.every((r) => selected.has(r.domain)));
	const someShown = $derived(!allShown && shown.some((r) => selected.has(r.domain)));

	function toggleAll() {
		if (allShown) for (const r of shown) selected.delete(r.domain);
		else for (const r of shown) selected.add(r.domain);
	}
	function toggle(domain: string) {
		if (selected.has(domain)) selected.delete(domain);
		else selected.add(domain);
	}
	const indeterminate = (on: boolean) => (el: HTMLInputElement) => {
		el.indeterminate = on;
	};

	// ── Bulk auto-renew ─────────────────────────────────────────────────────────────────────────────────
	let reviewing = $state(false);
	let target = $state(true);
	let busy = $state(false);
	let applyError = $state<ApiError | null>(null);
	let outcome = $state<{ on: boolean; result: BulkAutoRenew } | null>(null);

	const toChange = $derived(selectedRows.filter((r) => r.autoRenew !== target));
	const unchanged = $derived(selectedRows.length - toChange.length);
	const changes = $derived<ReviewChange[]>(
		toChange.map((r) => ({
			kind: 'edit',
			title: `Auto-renew for ${r.domain}`,
			before: r.autoRenew ? 'on' : 'off',
			after: target ? 'on' : 'off',
			...(r.apiAccess ? {} : { note: 'API access is off for this domain, so Porkbun will refuse this one.' })
		}))
	);
	const failed = $derived(outcome?.result.results.filter((r) => !r.ok) ?? []);
	const succeeded = $derived((outcome?.result.results.length ?? 0) - failed.length);

	function review(on: boolean) {
		target = on;
		applyError = null;
		reviewing = true;
	}

	async function apply() {
		busy = true;
		applyError = null;
		const on = target;
		const res = await sendJson<BulkAutoRenew>('PUT', '/api/porkbun/auto-renew', {
			on,
			domains: toChange.map((r) => r.domain)
		});
		busy = false;
		if (!res.ok) {
			applyError = res.error;
			return;
		}
		outcome = { on, result: res.data };
		for (const r of res.data.results) if (r.ok) selected.delete(r.domain);
		reviewing = false;
		await invalidateAll();
	}

	// ── Refresh ─────────────────────────────────────────────────────────────────────────────────────────
	let refreshing = $state(false);
	async function refresh() {
		refreshing = true;
		await Promise.all([
			fetch('/api/porkbun/domains?force').catch(() => null),
			fetch('/api/porkbun/account?force').catch(() => null)
		]);
		await invalidateAll();
		refreshing = false;
	}

	// ── Account ─────────────────────────────────────────────────────────────────────────────────────────
	const balance = $derived(data.account?.balance);
	const spend = $derived(data.account?.spend);
	const spendNote = $derived.by(() => {
		if (!spend?.ok) return 'API spend limit not readable';
		const cap = spend.data.spendLimit;
		if (!cap || cap.remaining === null) return 'No API spend limit set';
		return `${formatCents(cap.remaining)} of API spend left this month`;
	});

	const expiryKind = (days: number | null, autoRenew: boolean) => {
		const state = expiryState(days);
		if (state === 'expired') return 'error';
		if (state === 'soon') return autoRenew ? 'neutral' : 'warning';
		return null;
	};
	const first = $derived(current * PAGE_SIZE + 1);
	const last = $derived(Math.min(shown.length, (current + 1) * PAGE_SIZE));
</script>

<PageHero
	kicker="Porkbun"
	title="Domains"
	lede="The domains in your Porkbun account, when each one expires and whether it renews by itself."
/>

{#if data.listError}
	<section class="fp-section">
		<PorkbunNotice error={data.listError} />
		<p>
			<button class="fp-btn" type="button" onclick={refresh} disabled={refreshing}>
				<RefreshCw class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
				{refreshing ? 'Trying again…' : 'Try again'}
			</button>
		</p>
	</section>
{:else if data.list}
	<section class="fp-section">
		<div class="fp-tiles">
			<button type="button" class="fp-tile tile" onclick={() => setFilter('all')}>
				<span class="fp-tile__label">Domains</span>
				<span class="fp-tile__value">{formatNumber(rows.length)}</span>
				<span class="fp-tile__note"
					>{counts['api-off'] === 0
						? 'All open to the API'
						: `${formatNumber(counts['api-off'])} with API access off`}</span
				>
			</button>
			<button type="button" class="fp-tile tile" onclick={() => setFilter('soon')}>
				<span class="fp-tile__label">Expiring soon</span>
				<span class="fp-tile__value">{formatNumber(counts.soon)}</span>
				<span class="fp-tile__note">Within {EXPIRING_SOON_DAYS} days, or already expired</span>
			</button>
			<button type="button" class="fp-tile tile" onclick={() => setFilter('renew-off')}>
				<span class="fp-tile__label">Auto-renew off</span>
				<span class="fp-tile__value">{formatNumber(counts['renew-off'])}</span>
				<span class="fp-tile__note">These lapse unless renewed at Porkbun</span>
			</button>
			<div class="fp-tile">
				<span class="fp-tile__label">Account credit</span>
				<span class="fp-tile__value t-mono"
					>{balance?.ok ? balance.data.display || formatCents(balance.data.cents) : '—'}</span
				>
				<span class="fp-tile__note">{balance?.ok ? spendNote : 'The API key may not read the balance'}</span>
			</div>
		</div>
		<div class="asof">
			<AsOf at={data.list.fetchedAt} timeZone={data.timeZone} stale={data.list.stale} />
			<button class="fp-btn fp-btn--quiet" type="button" onclick={refresh} disabled={refreshing}>
				<RefreshCw class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
				{refreshing ? 'Refreshing…' : 'Refresh'}
			</button>
		</div>
		{#if data.list.pricingError}
			<Notice kind="warning">
				<b>Renewal prices could not be read.</b>
				{data.list.pricingError.message} The rest of the list is current.
			</Notice>
		{/if}
	</section>

	{#if outcome}
		<section class="fp-section" aria-live="polite">
			{#if succeeded > 0}
				<Notice kind="success">
					Auto-renew is now {outcome.on ? 'on' : 'off'} for {formatNumber(succeeded)}
					{succeeded === 1 ? 'domain' : 'domains'}.
				</Notice>
			{/if}
			{#if failed.length > 0}
				<Notice kind="error">
					<p>
						<b
							>Porkbun did not change {formatNumber(failed.length)}
							{failed.length === 1 ? 'domain' : 'domains'}.</b
						>
						{failed.length === 1 ? 'It is' : 'They are'} still selected, so you can try again.
					</p>
					<ul class="failures">
						{#each failed as f (f.domain)}
							<li><span class="t-mono">{f.domain}</span>: {f.message || 'no reason given'}</li>
						{/each}
					</ul>
				</Notice>
			{/if}
			<PorkbunNotice warnings={outcome.result.warnings} />
		</section>
	{/if}

	<section class="fp-section">
		<div class="fp-filters">
			<label class="fp-field fp-search">
				<Search class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
				<input
					type="search"
					placeholder="Search domains and labels"
					aria-label="Search domains and labels"
					bind:value={query}
					oninput={onSearch}
				/>
			</label>
			<div class="fp-chips" role="group" aria-label="Filter domains">
				{#each DOMAIN_FILTERS as f (f.id)}
					<button
						class="fp-chip"
						type="button"
						aria-pressed={filter === f.id}
						onclick={() => setFilter(f.id)}
					>
						{f.label} <span class="fp-chip__n">{formatNumber(counts[f.id])}</span>
					</button>
				{/each}
			</div>
		</div>

		{#if selected.size > 0}
			<div class="fp-well bulk" role="region" aria-label="Selected domains">
				<span class="t-ui"><b>{formatNumber(selected.size)}</b> selected</span>
				<ScopeGate status={data.porkbun} scope="domains">
					{#snippet children({ disabled })}
						<button class="fp-btn" type="button" {disabled} onclick={() => review(true)}
							>Turn auto-renew on</button
						>
						<button class="fp-btn" type="button" {disabled} onclick={() => review(false)}
							>Turn auto-renew off</button
						>
					{/snippet}
				</ScopeGate>
				<button class="fp-btn fp-btn--quiet" type="button" onclick={() => selected.clear()}>Clear</button>
			</div>
		{/if}

		{#if rows.length === 0}
			<EmptyState
				title="No domains in this Porkbun account"
				line="Domains registered or transferred to the account appear here."
			/>
		{:else if shown.length === 0}
			<EmptyState title="No domains match" line="Try another search or pick All." />
		{:else}
			<div class="fp-panel fp-table__wrap">
				<table class="fp-table">
					<caption class="visually-hidden">
						Domains in the Porkbun account{filter !== 'all' || query.trim() ? ', filtered' : ''}
					</caption>
					<thead>
						<tr>
							<th scope="col" class="pick">
								<input
									type="checkbox"
									aria-label="Select all {formatNumber(shown.length)} domains shown"
									checked={allShown}
									{@attach indeterminate(someShown)}
									onchange={toggleAll}
								/>
							</th>
							<th scope="col" aria-sort={ariaSort('domain')}>
								<button class="sort" type="button" onclick={() => sortBy('domain')}>
									Domain {@render arrow('domain')}
								</button>
							</th>
							<th scope="col" aria-sort={ariaSort('expires')}>
								<button class="sort" type="button" onclick={() => sortBy('expires')}>
									Expires {@render arrow('expires')}
								</button>
							</th>
							<th scope="col">Auto-renew</th>
							<th scope="col" class="num" aria-sort={ariaSort('renewal')}>
								<button class="sort" type="button" onclick={() => sortBy('renewal')}>
									Renewal {@render arrow('renewal')}
								</button>
							</th>
							<th scope="col">Notes</th>
						</tr>
					</thead>
					<tbody>
						{#each visible as r (r.domain)}
							{@const days = daysUntil(r.expireDate, now)}
							{@const kind = expiryKind(days, r.autoRenew)}
							<tr class:picked={selected.has(r.domain)}>
								<td class="pick">
									<input
										type="checkbox"
										aria-label="Select {r.domain}"
										checked={selected.has(r.domain)}
										onchange={() => toggle(r.domain)}
									/>
								</td>
								<td>
									<a class="t-mono name" href={domainHref(r.domain)}>{r.domain}</a>
									{#if r.labels.length > 0}
										<div class="labels">
											{#each r.labels as l (l.id)}<Tag>{l.title}</Tag>{/each}
										</div>
									{/if}
								</td>
								<td class="when">
									{#if r.expireDate}
										{@const at = Date.parse(r.expireDate)}
										<time datetime={r.expireDate} title={formatDateTime(at, data.timeZone)}
											>{formatDate(at, data.timeZone)}</time
										>
										{#if kind}
											<Tag {kind}>{days !== null && days < 0 ? 'expired' : formatCountdown(days)}</Tag>
										{:else}
											<span class="t-caption">{formatCountdown(days)}</span>
										{/if}
									{:else}<span class="t-muted">unknown</span>{/if}
								</td>
								<td>
									{#if r.autoRenew}<Tag kind="success">on</Tag>{:else}<Tag>off</Tag>{/if}
								</td>
								<td class="num t-mono">{formatUsd(r.renewal)}</td>
								<td>
									<div class="labels">
										{#if r.status !== 'ACTIVE'}<Tag kind="warning">{r.status || 'status unknown'}</Tag>{/if}
										{#if !r.apiAccess}<Tag kind="error">API access off</Tag>{/if}
										{#if r.notLocal}<Tag kind="warning">managed elsewhere</Tag>{/if}
										{#if !r.securityLock}<Tag kind="warning">unlocked</Tag>{/if}
										{#if !r.whoisPrivacy}<Tag>no WHOIS privacy</Tag>{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="fp-pager">
				<p class="fp-pager__info">
					{shown.length <= PAGE_SIZE
						? shown.length === rows.length
							? `${formatNumber(rows.length)} domains`
							: `${formatNumber(shown.length)} of ${formatNumber(rows.length)} domains`
						: `${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(shown.length)}${shown.length === rows.length ? '' : ` (${formatNumber(rows.length)} in all)`}`}
				</p>
				{#if pages > 1}
					<div class="pager">
						<button
							class="fp-btn"
							type="button"
							disabled={current === 0}
							onclick={() => (pageIndex = current - 1)}>Previous</button
						>
						<span class="t-ui">Page {current + 1} of {pages}</span>
						<button
							class="fp-btn"
							type="button"
							disabled={current >= pages - 1}
							onclick={() => (pageIndex = current + 1)}>Next</button
						>
					</div>
				{/if}
			</div>
		{/if}
	</section>

	<ReviewDialog
		bind:open={reviewing}
		title="Turn auto-renew {target ? 'on' : 'off'}"
		intro={target
			? 'Porkbun renews these domains from the account credit before they expire.'
			: 'These domains will not be renewed by Porkbun. Each lapses at its expiry date unless it is renewed by hand.'}
		{changes}
		blocked={toChange.length === 0
			? `Every selected domain already has auto-renew ${target ? 'on' : 'off'}.`
			: null}
		applyLabel={busy
			? 'Applying…'
			: `Turn ${target ? 'on' : 'off'} for ${formatNumber(toChange.length)} ${toChange.length === 1 ? 'domain' : 'domains'}`}
		{busy}
		error={applyError}
		onapply={apply}
	>
		{#if unchanged > 0 && toChange.length > 0}
			<p class="t-ui t-muted">
				{formatNumber(unchanged)} selected {unchanged === 1 ? 'domain already has' : 'domains already have'} it
				{target ? 'on' : 'off'} and {unchanged === 1 ? 'is' : 'are'} left alone.
			</p>
		{/if}
	</ReviewDialog>
{/if}

{#snippet arrow(key: DomainSortKey)}
	{#if sort.key !== key}
		<ArrowUpDown class="fp-ico fp-ico--sm faint" strokeWidth={1.4} aria-hidden="true" />
	{:else if sort.dir === 'asc'}
		<ArrowUp class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
	{:else}
		<ArrowDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
	{/if}
{/snippet}

<style>
	.tile {
		text-align: left;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}
	.tile:hover {
		border-color: var(--line);
		background: var(--raised);
	}
	.asof {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}
	.fp-chip__n {
		font: 500 11px/16px var(--font-mono);
		color: var(--faint);
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3) var(--space-4);
	}
	.failures {
		margin: var(--space-2) 0 0;
		padding-left: var(--space-5);
		list-style: disc;
	}
	.pick {
		width: 36px;
	}
	.pick input {
		width: 16px;
		height: 16px;
		accent-color: var(--acc);
		cursor: pointer;
	}
	tr.picked td {
		background: var(--acc-soft);
	}
	.sort {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.num .sort {
		flex-direction: row-reverse;
	}
	.sort :global(.faint) {
		color: var(--faint);
	}
	.name {
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.labels {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin-top: var(--space-1);
	}
	.when {
		white-space: nowrap;
	}
	.when time {
		margin-right: var(--space-2);
	}
	.pager {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
</style>
