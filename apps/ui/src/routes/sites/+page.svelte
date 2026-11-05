<script lang="ts">
	import { enhance } from '$app/forms';
	import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Power, PowerOff, Search, Trash2 } from '@lucide/svelte';
	import { Dialog, EmptyState, Notice, PageHero, Tag } from '$lib/design/components';
	import { formatElapsed, formatNumber } from '$lib/format';
	import type { SiteRow } from './+page.server';

	let { data, form } = $props();

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
	const count = (f: Filter) =>
		f === 'all' ? data.rows.length : data.rows.filter((r) => r.status === f).length;
	const filtering = $derived(query.trim() !== '' || filter !== 'all');
	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return data.rows.filter(
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
		return `${r.status === 'up' ? 'Up' : 'Down'} for ${formatElapsed(data.asOf - r.since)}`;
	}

	// Dialogs: one open at a time.
	let adding = $state(false);
	let copying = $state<SiteRow | null>(null);
	let deleting = $state<SiteRow | null>(null);
	let starter = $state('reverse_proxy');
	const starterDef = $derived(data.starters.find((s) => s.id === starter));

	function submit(close: () => void) {
		return () => {
			busy = true;
			return async ({ result, update }: { result: { type: string }; update: () => Promise<void> }) => {
				await update();
				busy = false;
				if (result.type === 'success') close();
			};
		};
	}
	const quiet = () => {
		busy = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = false;
		};
	};
</script>

<PageHero
	kicker="Caddyfile"
	title="Sites"
	lede="Every site block in the Caddyfile, with whether it is up and for how long. Changes are validated by Caddy before they are written."
/>

{#if form?.message && !adding && !copying && !deleting}
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
{#if data.caddyfileError}
	<section class="fp-section"><Notice kind="warning">{data.caddyfileError}</Notice></section>
{:else if !data.probing && data.rows.length > 0}
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

	{#if data.rows.length === 0}
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
							<td>
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
								{#if r.certDays === null}—{:else if r.certDays <= 14}
									<Tag kind={r.certDays <= 0 ? 'error' : 'warning'}
										>{r.certDays <= 0 ? 'expired' : `${r.certDays} d`}</Tag
									>
								{:else}{r.certDays} d{/if}
							</td>
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
			{shown.length === data.rows.length
				? `${formatNumber(data.rows.length)} sites`
				: `${formatNumber(shown.length)} of ${formatNumber(data.rows.length)} sites`}
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
	<form method="POST" action="?/add" class="stack" use:enhance={submit(() => (adding = false))}>
		<input type="hidden" name="baseHash" value={data.hash} />
		<label class="lbl">
			<span class="t-ui">Address</span>
			<span class="fp-field"
				><input name="addresses" placeholder="app.example.com" required autocomplete="off" /></span
			>
			<span class="t-caption t-muted">Several addresses can be separated by commas.</span>
		</label>
		<label class="lbl">
			<span class="t-ui">Start from</span>
			<span class="fp-select">
				<select name="starter" bind:value={starter}>
					{#each data.starters as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
				</select>
			</span>
		</label>
		{#if starterDef?.field}
			<label class="lbl">
				<span class="t-ui">{starterDef.field.label}</span>
				<span class="fp-field"
					><input name="value" placeholder={starterDef.field.placeholder} required autocomplete="off" /></span
				>
			</label>
		{/if}
		{#if form?.message && !('ok' in form)}<Notice kind="error">{form.message}</Notice>{/if}
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

<style>
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
