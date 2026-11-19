<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Power, PowerOff, Search, Trash2 } from '@lucide/svelte';
	import { writeBlock } from '$lib/api/porkbun';
	import type { DnsHint, SiteDnsCheck } from '$lib/api/porkbun-caddy';
	import { Dialog, EmptyState, Notice, PageHero, Tag } from '$lib/design/components';
	import { formatElapsed, formatNumber } from '$lib/format';
	import { autoRefresh } from '$lib/stats/view';
	import { Streamed } from '$lib/stats/streamed.svelte';
	import { Dns01Dialog, DnsStatusTag, RecordFixDialog, TieInState, worst } from '$lib/porkbun/caddy';
	import { PorkbunNotice, ScopeGate } from '$lib/porkbun/components';
	import RecipePicker from '$lib/visual/components/RecipePicker.svelte';
	import SitesSkeleton from '$lib/stats/SitesSkeleton.svelte';
	import { recipeDefaults, type Recipe } from '$lib/visual/recipes';
	import type { SiteList, SiteRow } from './+page.server';

	let { data, form } = $props();

	// The list arrives with the page, or streams in right after it on a cold start (placeholders until then).
	// Statuses refresh every 30 s while the tab is visible, in place.
	const list = new Streamed<SiteList>(() => data.list);
	const rows = $derived(list.current?.rows ?? []);
	const asOf = $derived(list.current?.asOf ?? 0);
	onMount(() => autoRefresh());

	type Filter = 'all' | 'up' | 'down' | 'unknown' | 'disabled';
	let query = $state('');
	let filter = $state<Filter>('all');
	let busy = $state(false);

	const FILTERS: { id: Filter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'up', label: 'Up' },
		{ id: 'down', label: 'Down' },
		{ id: 'unknown', label: 'Unknown' },
		{ id: 'disabled', label: 'Disabled' }
	];
	const count = (f: Filter) => (f === 'all' ? rows.length : rows.filter((r) => r.status === f).length);
	const filtering = $derived(query.trim() !== '' || filter !== 'all');
	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return rows.filter(
			(r: SiteRow) =>
				(filter === 'all' || r.status === filter) &&
				(q === '' || r.addresses.some((a) => a.toLowerCase().includes(q)))
		);
	});

	const name = (r: SiteRow) => r.addresses.join(', ');
	const editable = $derived(data.unsupported === null && data.fileExists);

	function since(r: SiteRow): string {
		if (r.status === 'disabled') return 'Commented out';
		if (r.since === null || r.status === 'unknown') return '—';
		return `${r.status === 'up' ? 'Up' : 'Down'} for ${formatElapsed(asOf - r.since)}`;
	}

	// Dialogs: one open at a time.
	let adding = $state(false);
	let copying = $state<SiteRow | null>(null);
	let deleting = $state<SiteRow | null>(null);
	// The Add dialog: the same recipes the visual editor offers, rendered on the server by the `add` action.
	const recipes = $derived(data.recipes.map((r) => ({ ...r, body: () => [] })) as Recipe[]);
	let recipe = $state('reverse_proxy');
	// svelte-ignore state_referenced_locally
	let values = $state<Record<string, string>>(
		recipeDefaults(recipes.find((r) => r.id === 'reverse_proxy') ?? recipes[0]!)
	);
	const addError = $derived(
		form?.message && !('ok' in form) && 'field' in form && typeof form.field === 'string'
			? { field: form.field, message: form.message }
			: null
	);

	// The DNS column (docs/porkbun-plan.md §4): what the records at Porkbun say about each site's names. Asked
	// for after the list has rendered, and only when the UI has Porkbun keys.
	const dns = new TieInState();
	onMount(() => {
		if (data.porkbunOn) void dns.load();
	});
	const refreshDns = () => (data.porkbunOn ? dns.load() : Promise.resolve());

	type DnsCell = {
		/** The check to show: the worst of the site's addresses. Null when none is under a Porkbun domain. */
		shown: SiteDnsCheck | null;
		several: boolean;
		/** The first address one record change would fix. */
		fixable: SiteDnsCheck | null;
		wildcard: DnsHint | null;
		/** Something else is wrong with the site's DNS challenge. */
		challenge: DnsHint | null;
	};
	const dnsCells = $derived.by(() => {
		const cells: Record<string, DnsCell> = {};
		for (const r of rows) {
			const checks = dns.of(r.id);
			const hints = checks.flatMap((c) => c.hints);
			const top = worst(checks);
			cells[r.id] = {
				shown: top && top.status !== 'not_porkbun' ? top : null,
				several: checks.length > 1,
				fixable: checks.find((c) => c.fix !== null) ?? null,
				wildcard: hints.find((h) => h.code === 'wildcard_needs_dns01') ?? null,
				challenge: hints.find((h) => h.code !== 'wildcard_needs_dns01') ?? null
			};
		}
		return cells;
	});

	// The review step for a site's record, and the queue of them after a site was added.
	let fixing = $state<SiteDnsCheck | null>(null);
	let fixLead = $state<string | undefined>();
	let fixQueue: SiteDnsCheck[] = [];
	function fix(check: SiteDnsCheck, lead?: string) {
		fixLead = lead;
		fixing = check;
	}
	function fixClosed() {
		const next = fixQueue.shift();
		fixing = null;
		// The next address of the site that was just added, once this dialog has closed.
		if (next) setTimeout(() => fix(next, 'Next address of the new site.'));
	}
	/** After "Add site": offer the record for each new address that has none, as a second review step. */
	async function offerRecords(hosts: unknown) {
		if (!data.porkbunOn || !Array.isArray(hosts) || hosts.length === 0) return;
		await dns.load();
		if (writeBlock(dns.gate, 'dns')) return;
		const [first, ...rest] = (dns.tie?.sites ?? []).filter((s) => hosts.includes(s.host) && s.fix !== null);
		if (!first) return;
		fixQueue = rest;
		fix(first, 'The site was added to the Caddyfile.');
	}

	// The wildcard hint: give the site the Porkbun DNS challenge.
	let challenging = $state<SiteRow | null>(null);

	type Submitted = { result: { type: string; data?: Record<string, unknown> }; update: () => Promise<void> };
	function submit(close: () => void, then?: (data: Record<string, unknown>) => void | Promise<void>) {
		return () => {
			busy = true;
			return async ({ result, update }: Submitted) => {
				await update();
				busy = false;
				if (result.type !== 'success') return;
				close();
				if (then) await then(result.data ?? {});
				else void refreshDns();
			};
		};
	}
	const quiet = () => {
		busy = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = false;
			void refreshDns();
		};
	};
</script>

<PageHero
	kicker="Caddyfile"
	title="Sites"
	lede="Every site block in the Caddyfile, with whether it is up and for how long. Changes are validated by Caddy before they are written."
/>

{#if form?.message && !adding && !copying && !deleting && !challenging}
	<section class="fp-section" aria-live="polite">
		<Notice kind={'ok' in form ? 'success' : 'error'}>
			{form.message}
			{#if 'conflict' in form && form.conflict}
				<a href="/sites" data-sveltekit-reload>Reload the list</a> to see the current file.
			{/if}
		</Notice>
	</section>
{/if}
{#if data.unsupported}
	<section class="fp-section">
		<Notice kind="warning"><b>Editing from this list is off.</b> {data.unsupported}</Notice>
	</section>
{/if}
{#if dns.error}
	<section class="fp-section">
		<PorkbunNotice error={dns.error} />
	</section>
{/if}
{#if list.error}
	<section class="fp-section">
		<Notice kind="error"
			><b>The site list did not load.</b> {list.error} It is tried again in 30 seconds.</Notice
		>
	</section>
{/if}
{#if list.current?.caddyfileError}
	<section class="fp-section"><Notice kind="warning">{list.current.caddyfileError}</Notice></section>
{:else if list.current && !list.current.probing && rows.length > 0}
	<section class="fp-section">
		<Notice>The first checks have not finished, so statuses show as unknown for a moment.</Notice>
	</section>
{/if}

<section class="fp-section">
	<div class="fp-filters bar">
		<label class="fp-field fp-search">
			<Search class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
			<input type="search" placeholder="Search sites" aria-label="Search sites" bind:value={query} />
		</label>
		<div class="fp-chips" role="group" aria-label="Filter by status">
			{#each FILTERS as f (f.id)}
				<button class="fp-chip" type="button" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>
					{f.label} <span class="fp-chip__n">{formatNumber(count(f.id))}</span>
				</button>
			{/each}
		</div>
		<button
			class="fp-btn fp-btn--primary add"
			type="button"
			disabled={!editable}
			onclick={() => (adding = true)}
		>
			<Plus class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Add site
		</button>
	</div>

	{#if !list.current}
		<SitesSkeleton rows={data.siteCount} dns={data.porkbunOn} />
	{:else if rows.length === 0}
		<EmptyState
			title="No sites in the Caddyfile"
			line={data.fileExists
				? 'Add one and it appears here with its status.'
				: 'The Caddyfile does not exist yet.'}
		/>
	{:else if shown.length === 0}
		<EmptyState title="No sites match" line="Try another search or clear the status filter." />
	{:else}
		<div class="fp-panel fp-table__wrap">
			<table class="fp-table">
				<caption class="visually-hidden">
					Site blocks in Caddyfile order{filtering ? ', filtered' : ''}
				</caption>
				<thead>
					<tr>
						<th scope="col">Status</th>
						<th scope="col">Site</th>
						<th scope="col">Since</th>
						<th scope="col" class="num">Upstreams</th>
						<th scope="col" class="num">24 h</th>
						<th scope="col" class="num">Cert</th>
						{#if data.porkbunOn}<th scope="col" title="What the records at Porkbun say about the site's names"
								>DNS</th
							>{/if}
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each shown as r, i (r.id)}
						<tr class:off={r.disabled}>
							<td>
								<Tag kind={r.status === 'up' ? 'success' : r.status === 'down' ? 'error' : 'neutral'}>
									{r.status === 'up'
										? 'Up'
										: r.status === 'down'
											? 'Down'
											: r.status === 'disabled'
												? 'Disabled'
												: 'Unknown'}
								</Tag>
							</td>
							<td class="name">
								<a class="site" href={r.disabled ? `/editor?site=${r.id}` : `/sites/${r.id}`}
									>{r.addresses[0]}</a
								>
								{#if r.addresses.length > 1}
									<div class="t-ui t-muted">{r.addresses.slice(1).join(', ')}</div>
								{/if}
							</td>
							<td class="t-ui">{since(r)}</td>
							<td class="num">
								{#if r.upstreams.total === 0}—{:else if r.upstreams.down > 0}
									<span class="bad">{r.upstreams.down} of {r.upstreams.total} down</span>
								{:else}{r.upstreams.total}{/if}
							</td>
							<td class="num"
								>{r.uptime24h === null
									? '—'
									: `${(r.uptime24h * 100).toFixed(r.uptime24h === 1 ? 0 : 1)}%`}</td
							>
							<td class="num">
								{#if r.certDays === null}—{:else if r.certDays < data.certWarnDays}
									<Tag kind={r.certDays < 0 ? 'error' : 'warning'}
										>{r.certDays < 0 ? 'expired' : `${r.certDays} d`}</Tag
									>
								{:else}{r.certDays} d{/if}
							</td>
							{#if data.porkbunOn}
								{@const cell = dnsCells[r.id]}
								<td>
									{#if !dns.tie}
										<span class="t-faint">{dns.loading ? 'Checking…' : '—'}</span>
									{:else if !cell || (!cell.shown && !cell.wildcard && !cell.challenge)}
										<span class="t-faint">—</span>
									{:else}
										<div class="dns">
											{#if cell.shown}<DnsStatusTag check={cell.shown} named={cell.several} />{/if}
											{#if cell.fixable}
												{@const target = cell.fixable}
												<ScopeGate status={dns.gate} scope="dns" showReason={false}>
													{#snippet children({ disabled })}
														<button
															type="button"
															class="fp-btn dns__btn"
															disabled={disabled || busy}
															aria-label="{target.fix?.kind === 'edit'
																? 'Point the record at this server'
																: 'Create the DNS record'} for {target.host}"
															onclick={() => fix(target)}
														>
															{target.fix?.kind === 'edit' ? 'Fix' : 'Create'}
														</button>
													{/snippet}
												</ScopeGate>
											{/if}
											{#if cell.wildcard}
												<a href="/sites/{r.id}#dns" title={cell.wildcard.message}
													><Tag kind="warning">Needs DNS challenge</Tag></a
												>
												{#if cell.wildcard.canAddPorkbun}
													<button
														type="button"
														class="fp-btn dns__btn"
														disabled={!editable || busy}
														aria-label="Use the Porkbun DNS challenge for {name(r)}"
														onclick={() => (challenging = r)}
													>
														Set up
													</button>
												{/if}
											{/if}
											{#if cell.challenge}
												<a href="/sites/{r.id}#dns" title={cell.challenge.message}
													><Tag kind="warning">DNS challenge</Tag></a
												>
											{/if}
										</div>
									{/if}
								</td>
							{/if}
							<td>
								<div class="acts">
									<form method="POST" action="?/move" use:enhance={quiet}>
										<input type="hidden" name="baseHash" value={data.hash} />
										<input type="hidden" name="id" value={r.id} />
										<input type="hidden" name="direction" value="up" />
										<button
											class="fp-ibtn"
											disabled={!editable || busy || filtering || i === 0}
											aria-label="Move {name(r)} up"
											title={filtering ? 'Clear the search and filter to reorder' : 'Move up'}
										>
											<ArrowUp class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
										</button>
									</form>
									<form method="POST" action="?/move" use:enhance={quiet}>
										<input type="hidden" name="baseHash" value={data.hash} />
										<input type="hidden" name="id" value={r.id} />
										<input type="hidden" name="direction" value="down" />
										<button
											class="fp-ibtn"
											disabled={!editable || busy || filtering || i === shown.length - 1}
											aria-label="Move {name(r)} down"
											title={filtering ? 'Clear the search and filter to reorder' : 'Move down'}
										>
											<ArrowDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
										</button>
									</form>
									<a
										class="fp-ibtn"
										href="/editor?site={r.id}&line={r.line}"
										aria-label="Edit {name(r)}"
										title="Edit"
									>
										<Pencil class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
									</a>
									<button
										class="fp-ibtn"
										type="button"
										disabled={!editable || busy || r.disabled}
										aria-label="Duplicate {name(r)}"
										title={r.disabled ? 'Enable the site first' : 'Duplicate'}
										onclick={() => (copying = r)}
									>
										<Copy class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
									</button>
									<form method="POST" action="?/toggle" use:enhance={quiet}>
										<input type="hidden" name="baseHash" value={data.hash} />
										<input type="hidden" name="id" value={r.id} />
										<input type="hidden" name="disable" value={r.disabled ? '0' : '1'} />
										<button
											class="fp-ibtn"
											disabled={!editable || busy}
											aria-label="{r.disabled ? 'Enable' : 'Disable'} {name(r)}"
											title={r.disabled ? 'Enable' : 'Disable (comment out)'}
										>
											{#if r.disabled}
												<Power class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
											{:else}
												<PowerOff class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
											{/if}
										</button>
									</form>
									<button
										class="fp-ibtn"
										type="button"
										disabled={!editable || busy}
										aria-label="Delete {name(r)}"
										title="Delete"
										onclick={() => (deleting = r)}
									>
										<Trash2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="fp-pager__info">
			{shown.length === rows.length
				? `${formatNumber(rows.length)} sites`
				: `${formatNumber(shown.length)} of ${formatNumber(rows.length)} sites`}
		</p>
	{/if}
</section>

<section class="fp-section fp-two">
	<div class="fp-panel entry">
		<h2 class="t-title-2">Global options</h2>
		<p class="t-ui t-muted">
			{data.globals
				? 'The block at the top of the Caddyfile: email, admin endpoint, servers, logging.'
				: 'This Caddyfile has no global options block yet.'}
		</p>
		<a class="fp-btn" href="/globals">{data.globals ? 'Open global options' : 'Set up global options'}</a>
	</div>
	<div class="fp-panel entry">
		<h2 class="t-title-2">Snippets</h2>
		{#if data.snippets.length === 0}
			<p class="t-ui t-muted">
				No snippets. A snippet is a reusable chunk of config that sites pull in with <code>import</code>.
			</p>
		{:else}
			<div class="fp-chips">
				{#each data.snippets as s (s)}<Tag>{s}</Tag>{/each}
			</div>
		{/if}
		<a class="fp-btn" href="/globals#snippets">Open snippets</a>
	</div>
</section>

<Dialog bind:open={adding} title="Add a site">
	<form
		method="POST"
		action="?/add"
		class="stack"
		use:enhance={submit(
			() => (adding = false),
			(result) => offerRecords(result.added)
		)}
	>
		<input type="hidden" name="baseHash" value={data.hash} />
		<label class="lbl">
			<span class="t-ui">Address</span>
			<span class="fp-field"
				><input name="addresses" placeholder="app.example.com" required autocomplete="off" /></span
			>
			<span class="t-caption t-muted">Several addresses can be separated by commas.</span>
		</label>
		<RecipePicker {recipes} bind:recipe bind:values kinds={['site']} error={addError} />
		{#if form?.message && !('ok' in form) && !addError}<Notice kind="error">{form.message}</Notice>{/if}
		<div class="foot">
			<button class="fp-btn" type="button" onclick={() => (adding = false)}>Cancel</button>
			<button class="fp-btn fp-btn--primary" disabled={busy}>{busy ? 'Adding…' : 'Add site'}</button>
		</div>
	</form>
</Dialog>

<Dialog open={copying !== null} title="Duplicate site" onclose={() => (copying = null)}>
	{#if copying}
		<form method="POST" action="?/duplicate" class="stack" use:enhance={submit(() => (copying = null))}>
			<input type="hidden" name="baseHash" value={data.hash} />
			<input type="hidden" name="id" value={copying.id} />
			<p class="t-ui t-muted">
				The new site gets a copy of everything inside <b>{name(copying)}</b>. Give it its own address.
			</p>
			<label class="lbl">
				<span class="t-ui">New address</span>
				<span class="fp-field"
					><input name="addresses" placeholder="app2.example.com" required autocomplete="off" /></span
				>
			</label>
			{#if form?.message && !('ok' in form)}<Notice kind="error">{form.message}</Notice>{/if}
			<div class="foot">
				<button class="fp-btn" type="button" onclick={() => (copying = null)}>Cancel</button>
				<button class="fp-btn fp-btn--primary" disabled={busy}>{busy ? 'Copying…' : 'Duplicate'}</button>
			</div>
		</form>
	{/if}
</Dialog>

<Dialog open={deleting !== null} title="Delete site" onclose={() => (deleting = null)}>
	{#if deleting}
		<form method="POST" action="?/delete" class="stack" use:enhance={submit(() => (deleting = null))}>
			<input type="hidden" name="baseHash" value={data.hash} />
			<input type="hidden" name="id" value={deleting.id} />
			<p class="t-body">
				Delete <b>{name(deleting)}</b> from the Caddyfile? Caddy stops serving it as soon as the change is
				applied. The previous version stays in <a href="/history">History</a>, so you can restore it.
			</p>
			<p class="t-ui t-muted">If you only want it off for a while, disable it instead.</p>
			{#if form?.message && !('ok' in form)}<Notice kind="error">{form.message}</Notice>{/if}
			<div class="foot">
				<button class="fp-btn" type="button" onclick={() => (deleting = null)}>Keep it</button>
				<button class="fp-btn fp-btn--primary" disabled={busy}>{busy ? 'Deleting…' : 'Delete site'}</button>
			</div>
		</form>
	{/if}
</Dialog>

<RecordFixDialog check={fixing} lead={fixLead} ondone={() => void refreshDns()} onclose={fixClosed} />

<Dns01Dialog
	site={challenging}
	action="?/dns01"
	baseHash={data.hash}
	pluginUnknown={dns.tie?.plugin.state === 'unknown'}
	error={challenging && form?.message && !('ok' in form) ? form.message : null}
	onclose={() => (challenging = null)}
	onresult={() => void refreshDns()}
/>

<style>
	.dns {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
	}
	/* The DNS column must not squeeze the names into a few letters per line. */
	.name {
		min-width: 11rem;
	}
	.dns a {
		text-decoration: none;
	}
	.dns__btn {
		height: 24px;
		padding: 0 var(--space-2);
		font-size: 13px;
	}
	.bar {
		justify-content: space-between;
	}
	.add {
		margin-left: auto;
	}
	.fp-chip__n {
		font: 500 11px/16px var(--font-mono);
		color: var(--faint);
	}
	.site {
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	tr.off .site,
	tr.off td:not(:first-child):not(:last-child) {
		color: var(--muted);
	}
	.bad {
		color: var(--error-ink);
	}
	.acts {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-1);
	}
	.acts form {
		display: contents;
	}
	.fp-ibtn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.entry {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-3);
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.lbl {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.lbl :global(.fp-field),
	.lbl :global(.fp-select) {
		width: 100%;
	}
	.lbl :global(.fp-select select) {
		width: 100%;
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
