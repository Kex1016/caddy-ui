<script lang="ts">
	import { Download, Pencil, Plus, RefreshCw, Search, Trash2, Undo2, Upload } from '@lucide/svelte';
	import { invalidateAll } from '$app/navigation';
	import {
		writeBlock,
		type ApiError,
		type DnsRecord,
		type DnsRecordInput,
		type DryRun
	} from '$lib/api/porkbun';
	import { AsOf, Dialog, EmptyState, Notice } from '$lib/design/components';
	import { PorkbunNotice, RecordValue, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import { planChanges } from '$lib/porkbun/records/plan';
	import {
		batchHeadline,
		blockedReason,
		overallDryRun,
		reviewChanges,
		statusText
	} from '$lib/porkbun/records/review';
	import {
		TRAY_LIMIT,
		afterBatch,
		inSendOrder,
		inputOf,
		pendingFor,
		restoreTray,
		serialiseTray,
		stageCreate,
		stageDelete,
		stageEdit,
		trayStorageKey,
		unstage,
		type Pending
	} from '$lib/porkbun/records/tray';
	import type { BatchResult, PlanRefusal, PlannedChange, Preview } from '$lib/porkbun/records/types';
	import { buildRows, countTypes, groupRows, matches, ttlLabel, type Row } from '$lib/porkbun/records/view';
	import { call, domainApi } from '$lib/porkbun/registry/api';
	import { isAtPorkbun } from '$lib/porkbun/registry/validate';
	import { domainHref } from '$lib/porkbun/tabs';
	import ChangeTray from './ChangeTray.svelte';
	import ImportPanel from './ImportPanel.svelte';
	import RecordForm from './RecordForm.svelte';

	let { data } = $props();
	const domain = $derived(data.domain?.domain ?? '');
	const records = $derived(data.zone?.data.records ?? []);
	const gate = $derived(writeBlock(data.porkbun, 'dns'));
	const locked = $derived(gate !== null);

	// ── Pending changes ──────────────────────────────────────────────────────────────────────────────────
	let tray = $state<Pending[]>([]);
	let trayFull = $state(false);

	// Picked up again after a reload: the tray is kept in this tab's session storage, per domain.
	$effect(() => {
		if (!domain) return;
		let stored: string | null = null;
		try {
			stored = sessionStorage.getItem(trayStorageKey(domain));
		} catch {
			// Storage is switched off: the tray lives in the page only.
		}
		tray = restoreTray(stored);
	});

	function setTray(next: Pending[]) {
		if (next.length > TRAY_LIMIT && next.length > tray.length) {
			trayFull = true;
			return;
		}
		trayFull = false;
		tray = next;
		try {
			if (next.length > 0) sessionStorage.setItem(trayStorageKey(domain), serialiseTray(next));
			else sessionStorage.removeItem(trayStorageKey(domain));
		} catch {
			// As above.
		}
	}

	// ── The table ────────────────────────────────────────────────────────────────────────────────────────
	let query = $state('');
	let typeFilter = $state('');
	let pendingOnly = $state(false);

	const rows = $derived(buildRows(records, tray, domain));
	const types = $derived(countTypes(rows));
	const visible = $derived(
		rows.filter((r) => matches(r, { query, type: typeFilter, pendingOnly: pendingOnly && tray.length > 0 }))
	);
	const groups = $derived(groupRows(visible));

	$effect(() => {
		if (typeFilter && !types.some((t) => t.type === typeFilter)) typeFilter = '';
	});

	let selected = $state<Record<string, boolean>>({});
	const selectable = (row: Row) => row.live !== null && row.known && row.state !== 'deleted';
	/** Only rows that are on screen count: a filter never hides something a bulk action then changes. */
	const chosen = $derived(visible.filter((r) => selectable(r) && selected[r.key]));
	const selectableShown = $derived(visible.filter(selectable));
	const allChosen = $derived(selectableShown.length > 0 && chosen.length === selectableShown.length);

	function chooseAll(on: boolean) {
		const next = { ...selected };
		for (const row of selectableShown) next[row.key] = on;
		selected = next;
	}

	let refreshing = $state(false);
	let refreshError = $state<ApiError | null>(null);
	async function refresh() {
		refreshing = true;
		const answer = await call('GET', `${domainApi(domain, 'dns')}?force`);
		refreshError = answer.ok ? null : answer.error;
		await invalidateAll();
		refreshing = false;
	}

	// ── Add and edit ─────────────────────────────────────────────────────────────────────────────────────
	type FormTarget = {
		title: string;
		saveLabel: string;
		live: DnsRecord | null;
		start: DnsRecordInput | null;
		/** The tray key of a pending add that is being edited. */
		key: string | null;
	};
	let formOpen = $state(false);
	let form = $state<FormTarget | null>(null);

	function addRecord() {
		form = { title: 'Add a record', saveLabel: 'Add to pending changes', live: null, start: null, key: null };
		formOpen = true;
	}

	function editPending(p: Pending) {
		if (p.change.op === 'create') {
			form = {
				title: 'Edit the record to add',
				saveLabel: 'Update pending change',
				live: null,
				start: p.change.record,
				key: p.key
			};
			formOpen = true;
		} else if (p.change.op === 'edit') {
			const id = p.change.id;
			const live = records.find((r) => r.id === id);
			if (!live) return;
			form = {
				title: `Edit ${live.type} ${live.name}`,
				saveLabel: 'Update pending change',
				live,
				start: p.change.record,
				key: null
			};
			formOpen = true;
		}
	}

	function editRow(row: Row) {
		const pending = row.live ? pendingFor(tray, row.live.id) : tray.find((p) => p.key === row.key);
		if (pending && pending.change.op !== 'delete') return editPending(pending);
		if (!row.live) return;
		form = {
			title: `Edit ${row.live.type} ${row.live.name}`,
			saveLabel: 'Add to pending changes',
			live: row.live,
			start: null,
			key: null
		};
		formOpen = true;
	}

	const formOthers = $derived(
		rows
			.filter((r) => r.state !== 'deleted' && r.key !== (form?.live?.id ?? form?.key ?? ''))
			.map((r) => r.shown)
	);

	function saveForm(record: DnsRecordInput) {
		if (!form) return;
		setTray(
			form.live ? stageEdit(tray, form.live, record) : stageCreate(tray, record, form.key ?? undefined)
		);
		formOpen = false;
	}

	function deleteRow(row: Row) {
		if (row.live) setTray(stageDelete(tray, [row.live]));
		else setTray(unstage(tray, row.key));
	}
	const takeBack = (row: Row) => setTray(unstage(tray, row.live ? `id:${row.live.id}` : row.key));

	function deleteChosen() {
		setTray(
			stageDelete(
				tray,
				chosen.flatMap((r) => (r.live ? [r.live] : []))
			)
		);
		selected = {};
	}

	// ── TTL of several records ───────────────────────────────────────────────────────────────────────────
	let ttlOpen = $state(false);
	let ttlText = $state('600');
	const ttlValue = $derived(/^\d{1,10}$/.test(ttlText.trim()) ? Number(ttlText.trim()) : null);
	const ttlOk = $derived(ttlValue !== null && ttlValue > 0 && ttlValue <= 2_147_483_647);

	function setTtlOfChosen() {
		if (!ttlOk || ttlValue === null) return;
		let next = tray;
		for (const row of chosen) {
			if (!row.live) continue;
			const pending = pendingFor(next, row.live.id);
			const base = pending?.change.op === 'edit' ? pending.change.record : inputOf(row.live);
			next = stageEdit(next, row.live, { ...base, ttl: ttlValue });
		}
		setTray(next);
		ttlOpen = false;
		selected = {};
	}

	// ── Review and apply ─────────────────────────────────────────────────────────────────────────────────
	let reviewOpen = $state(false);
	/** The tray as it was sent for review, in sending order. */
	let sent = $state<Pending[]>([]);
	let preview = $state<Preview | null>(null);
	let previewing = $state(false);
	let previewError = $state<ApiError | null>(null);
	let refused = $state<PlannedChange[] | null>(null);
	let applying = $state(false);
	let applyError = $state<ApiError | null>(null);
	let report = $state<BatchResult | null>(null);
	let seq = 0;

	const sentChanges = $derived(sent.map((p) => p.change));
	// The plan is worked out here at once, with the same code the server uses; the server's answer, made
	// against a fresh read of the zone, replaces it when it arrives.
	const plan: PlannedChange[] = $derived(
		refused ?? preview?.items ?? planChanges(records, sentChanges, domain)
	);
	const reviewList = $derived(reviewChanges(plan, sentChanges, data.marks));
	const deletes = $derived(sentChanges.filter((c) => c.op === 'delete').length);
	const blocked = $derived(
		blockedReason(plan) ??
			(previewError ? 'The changes could not be checked, so they can not be applied yet.' : null)
	);
	const rehearsal: DryRun | 'running' | null = $derived(
		previewing ? 'running' : preview && !refused ? overallDryRun(preview) : null
	);

	async function openReview() {
		const mine = ++seq;
		sent = inSendOrder(tray);
		preview = null;
		previewError = null;
		applyError = null;
		refused = null;
		previewing = true;
		reviewOpen = true;
		const answer = await call<Preview>('POST', domainApi(domain, 'dns', 'preview'), {
			changes: sent.map((p) => p.change)
		});
		if (mine !== seq) return;
		previewing = false;
		if (answer.ok) preview = answer.data;
		else previewError = answer.error;
	}

	const isRefusal = (body: unknown): body is PlanRefusal =>
		!!body && typeof body === 'object' && Array.isArray((body as PlanRefusal).items);

	async function apply() {
		applying = true;
		applyError = null;
		const answer = await call<BatchResult>('POST', domainApi(domain, 'dns', 'batch'), {
			changes: sentChanges,
			...(deletes > 1 ? { confirm: domain } : {})
		});
		applying = false;
		if (!answer.ok) {
			if (answer.status === 409 && isRefusal(answer.body)) refused = answer.body.items;
			applyError = answer.error;
			// The zone was read again to refuse this; show it.
			await invalidateAll();
			return;
		}
		report = answer.data;
		setTray(afterBatch(tray, sent, answer.data));
		reviewOpen = false;
		selected = {};
		await invalidateAll();
	}

	const reportIssues = $derived(
		(report?.items ?? []).filter((i) => i.status !== 'applied' && i.status !== 'unchanged')
	);

	// ── Import ───────────────────────────────────────────────────────────────────────────────────────────
	let importing = $state(false);

	const offPorkbun = $derived(data.nameservers !== null && !isAtPorkbun(data.nameservers));
</script>

<section class="fp-section" aria-labelledby="dns-title">
	<div class="fp-section__head">
		<h2 class="t-title-2" id="dns-title">DNS records</h2>
		<span class="head-end">
			{#if data.zone}<AsOf at={data.zone.fetchedAt} timeZone={data.timeZone} stale={data.zone.stale} />{/if}
			<button class="fp-btn fp-btn--quiet" type="button" disabled={refreshing} onclick={refresh}>
				<RefreshCw class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
				{refreshing ? 'Refreshing…' : 'Refresh'}
			</button>
		</span>
	</div>

	{#if refreshError}<PorkbunNotice error={refreshError} />{/if}
	{#if data.zoneError}
		<PorkbunNotice error={data.zoneError} />
	{:else if data.zone}
		{#if offPorkbun}
			<Notice kind="warning">
				<b>The world does not see these records.</b> This domain's nameservers are not Porkbun's, so its DNS
				is answered from somewhere else. Records can still be prepared here; they take effect when the
				nameservers on the <a href={domainHref(domain, 'registry')}>Registry tab</a> point at Porkbun.
			</Notice>
		{/if}
		{#if data.zone.stale}
			<Notice kind="warning">
				Porkbun could not be reached, so this is the zone as it was last read. Changes can not be applied
				until it can be read again.
			</Notice>
		{/if}

		{#if report}
			<Notice kind={report.ok ? 'success' : 'warning'}>
				<p>
					<b>{batchHeadline(report)}.</b>
					{#if !report.ok}The batch stopped at the first change that failed. What was not applied is still in
						the pending changes.{/if}
				</p>
				{#if reportIssues.length > 0}
					<ul class="issues">
						{#each reportIssues as item (item.index)}
							<li>
								<span class="t-mono">{item.type} {item.name}</span>: {statusText(item.status)}{item.error
									? `. ${item.error.message}`
									: item.status === 'adopted'
										? ', so nothing was created'
										: ''}
							</li>
						{/each}
					</ul>
				{/if}
			</Notice>
			<PorkbunNotice warnings={report.warnings.filter((w) => !w.startsWith('A record with this name'))} />
		{/if}

		<div class="fp-filters bar">
			<label class="fp-field fp-search">
				<Search class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
				<input type="search" placeholder="Search records" aria-label="Search records" bind:value={query} />
			</label>
			<div class="fp-chips" role="group" aria-label="Filter by type">
				<button
					class="fp-chip"
					type="button"
					aria-pressed={typeFilter === ''}
					onclick={() => (typeFilter = '')}
				>
					All <span class="n">{rows.length}</span>
				</button>
				{#each types as t (t.type)}
					<button
						class="fp-chip"
						type="button"
						aria-pressed={typeFilter === t.type}
						onclick={() => (typeFilter = typeFilter === t.type ? '' : t.type)}
					>
						{t.type} <span class="n">{t.count}</span>
					</button>
				{/each}
				{#if tray.length > 0}
					<button
						class="fp-chip"
						type="button"
						aria-pressed={pendingOnly}
						onclick={() => (pendingOnly = !pendingOnly)}
					>
						Pending <span class="n">{tray.length}</span>
					</button>
				{/if}
			</div>
			<span class="bar__end">
				<a class="fp-btn" href={domainApi(domain, 'dns', 'export')} download="{domain}.zone">
					<Download class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Export
				</a>
				<a
					class="fp-btn fp-btn--quiet"
					href="{domainApi(domain, 'dns', 'export')}?format=json"
					download="{domain}.json">as JSON</a
				>
				<button
					class="fp-btn"
					type="button"
					aria-expanded={importing}
					onclick={() => (importing = !importing)}
				>
					<Upload class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Import…
				</button>
				<ScopeGate status={data.porkbun} scope="dns" showReason={false}>
					{#snippet children({ disabled })}
						<button class="fp-btn fp-btn--primary" type="button" {disabled} onclick={addRecord}>
							<Plus class="fp-ico fp-ico--sm add-ico" strokeWidth={1.4} aria-hidden="true" /> Add record
						</button>
					{/snippet}
				</ScopeGate>
			</span>
		</div>
		{#if gate}<Notice><b>Records can be read, not changed.</b> {gate.message}.</Notice>{/if}
		{#if trayFull}
			<Notice kind="warning">
				The pending changes hold {TRAY_LIMIT} changes, which is as many as one batch takes. Apply them first. To
				add many records at once, use Import.
			</Notice>
		{/if}

		{#if importing}
			<ImportPanel
				{domain}
				status={data.porkbun}
				onchanged={() => invalidateAll()}
				onclose={() => (importing = false)}
			/>
		{/if}

		{#if chosen.length > 0}
			<div class="fp-panel bulk" role="group" aria-label="Selected records">
				<b class="t-ui">{chosen.length} selected</b>
				<button class="fp-btn" type="button" disabled={locked} onclick={() => (ttlOpen = true)}
					>Set TTL…</button
				>
				<button class="fp-btn" type="button" disabled={locked} onclick={deleteChosen}>
					<Trash2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Delete
				</button>
				<button class="fp-btn fp-btn--quiet" type="button" onclick={() => (selected = {})}
					>Clear selection</button
				>
				<span class="t-caption">Both go to the pending changes first.</span>
			</div>
		{/if}

		{#if rows.length === 0}
			<EmptyState
				title="No records yet"
				line="Add the first record, or import a zone file from wherever this domain's DNS was kept before."
			/>
		{:else if visible.length === 0}
			<EmptyState title="No record matches" line="Clear the search or pick another type." icon={Search} />
		{:else}
			<div class="fp-panel fp-table__wrap scroller">
				<table class="fp-table">
					<caption class="visually-hidden">DNS records of {domain}, grouped by name</caption>
					<thead>
						<tr>
							<th scope="col" class="tick">
								<input
									type="checkbox"
									aria-label="Select every record shown"
									checked={allChosen}
									disabled={selectableShown.length === 0}
									onchange={(e) => chooseAll(e.currentTarget.checked)}
								/>
							</th>
							<th scope="col">Type</th>
							<th scope="col">Value</th>
							<th scope="col" class="num">TTL</th>
							<th scope="col">Notes</th>
							<th scope="col"><span class="visually-hidden">Actions</span></th>
						</tr>
					</thead>
					{#each groups as group (group.host)}
						<tbody>
							<tr class="grp">
								<th colspan="6" scope="rowgroup" class="t-mono">{group.name}</th>
							</tr>
							{#each group.rows as row (row.key)}
								{@const what = `${row.shown.type} ${row.name}`}
								{@const marks = row.live ? data.marks[row.live.id] : undefined}
								<tr class:gone={row.state === 'deleted'} class:pending={row.state !== 'live'}>
									<td class="tick">
										{#if selectable(row)}
											<input type="checkbox" aria-label="Select {what}" bind:checked={selected[row.key]} />
										{/if}
									</td>
									<td><span class="t-mono type">{row.shown.type}</span></td>
									<td class="val">
										<RecordValue type={row.shown.type} content={row.shown.content} prio={row.shown.prio} />
										<span class="tags">
											{#if row.state === 'new'}<span class="fp-tag fp-tag--acc">to add</span>{/if}
											{#if row.state === 'edited'}
												<span
													class="fp-tag fp-tag--acc"
													title={row.live ? `Now: ${row.live.content} · TTL ${row.live.ttl}` : undefined}
													>to change: {row.changed
														.map((f) =>
															f === 'host'
																? 'name'
																: f === 'content'
																	? 'value'
																	: f === 'prio'
																		? 'priority'
																		: f === 'ttl'
																			? 'TTL'
																			: f
														)
														.join(', ')}</span
												>
											{/if}
											{#if row.state === 'deleted'}<span class="fp-tag fp-tag--error">to delete</span>{/if}
											{#if !row.known}
												<span
													class="fp-tag"
													title="This version of Caddy UI shows this type but does not change it"
													>read-only type</span
												>
											{/if}
											{#if marks?.managedByCaddy}
												<span
													class="fp-tag fp-tag--warning"
													title="Caddy creates and removes this record itself while it gets a certificate"
													>managed by Caddy</span
												>
											{/if}
											{#each (marks?.sites ?? []).slice(0, 2) as site (site.host)}
												{#if site.href}
													<a class="fp-tag fp-tag--success" href={site.href}>used by {site.host}</a>
												{:else}
													<span class="fp-tag fp-tag--success">used by {site.host}</span>
												{/if}
											{/each}
											{#if (marks?.sites.length ?? 0) > 2}
												<span
													class="fp-tag fp-tag--success"
													title={marks?.sites
														.slice(2)
														.map((s) => s.host)
														.join(', ')}>and {(marks?.sites.length ?? 0) - 2} more sites</span
												>
											{/if}
										</span>
									</td>
									<td class="num nowrap">
										<span class="t-mono ttl">{row.shown.ttl}</span>
										<span class="t-caption">{ttlLabel(row.shown.ttl)}</span>
									</td>
									<td class="notes">{row.shown.notes ?? ''}</td>
									<td>
										<div class="actions">
											{#if row.state !== 'live'}
												<button
													class="fp-ibtn"
													type="button"
													aria-label="Take back the pending change to {what}"
													title="Take back the pending change"
													onclick={() => takeBack(row)}
													><Undo2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /></button
												>
											{/if}
											{#if row.known && row.state !== 'deleted'}
												<button
													class="fp-ibtn"
													type="button"
													aria-label="Edit {what}"
													title={gate?.message ?? 'Edit'}
													disabled={locked}
													onclick={() => editRow(row)}
													><Pencil class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /></button
												>
												{#if row.live}
													<button
														class="fp-ibtn"
														type="button"
														aria-label="Delete {what}"
														title={gate?.message ?? 'Delete'}
														disabled={locked}
														onclick={() => deleteRow(row)}
														><Trash2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /></button
													>
												{/if}
											{/if}
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					{/each}
				</table>
			</div>
			<p class="t-caption">
				{visible.length === rows.length
					? `${rows.length} records`
					: `${visible.length} of ${rows.length} records`}. The SOA record and Porkbun's own NS records are
				not listed: Porkbun keeps those itself.
			</p>
		{/if}

		{#if tray.length > 0}
			<ChangeTray
				{domain}
				tray={inSendOrder(tray)}
				{records}
				disabled={locked || data.zone.stale}
				reason={gate?.message ?? null}
				onreview={openReview}
				onedit={editPending}
				onremove={(key) => setTray(unstage(tray, key))}
				onclear={() => setTray([])}
			/>
		{/if}
	{/if}
</section>

<Dialog bind:open={formOpen} title={form?.title ?? 'Record'}>
	{#if form}
		<RecordForm
			{domain}
			live={form.live}
			start={form.start}
			others={formOthers}
			saveLabel={form.saveLabel}
			onsave={saveForm}
			oncancel={() => (formOpen = false)}
		/>
	{/if}
</Dialog>

<Dialog bind:open={ttlOpen} title="Set the TTL of {chosen.length} record{chosen.length === 1 ? '' : 's'}">
	<form
		class="ttl-form"
		novalidate
		onsubmit={(e) => {
			e.preventDefault();
			setTtlOfChosen();
		}}
	>
		<div class="lbl">
			<label class="t-ui" for="ttl-all">TTL in seconds</label>
			<span class="fp-field"
				><input
					id="ttl-all"
					class="t-mono"
					inputmode="numeric"
					bind:value={ttlText}
					autocomplete="off"
					aria-invalid={ttlOk ? undefined : 'true'}
					aria-describedby="ttl-all-help"
				/></span
			>
			<span class="t-caption" class:bad={!ttlOk} id="ttl-all-help">
				{#if ttlOk && ttlValue !== null}{ttlLabel(ttlValue)}. Porkbun's minimum is usually 600 seconds.{:else}A
					whole number of seconds, above zero.{/if}
			</span>
		</div>
		<div class="foot">
			<button class="fp-btn" type="button" onclick={() => (ttlOpen = false)}>Cancel</button>
			<button class="fp-btn fp-btn--primary" type="submit" disabled={!ttlOk}>Add to pending changes</button>
		</div>
	</form>
</Dialog>

<ReviewDialog
	bind:open={reviewOpen}
	title="Review {sent.length} change{sent.length === 1 ? '' : 's'} to {domain}"
	intro="The changes are sent in this order: deletes, then edits, then new records. Porkbun checks each one first without changing anything. Nothing is sent until you apply."
	changes={reviewList}
	dryRun={rehearsal}
	{blocked}
	confirmText={deletes > 1 ? domain : null}
	confirmPurpose={deletes > 1 ? `to delete ${deletes} records` : undefined}
	destructive={deletes > 0}
	applyLabel="Apply {sent.length} change{sent.length === 1 ? '' : 's'}"
	busy={applying}
	error={applyError ?? previewError}
	onapply={apply}
	oncancel={() => (seq += 1)}
/>

<style>
	.head-end {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-3);
	}
	.bar__end {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
	}
	.bar :global(.add-ico) {
		color: inherit;
	}
	.n {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--faint);
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}
	/* Holds the visually hidden labels of the table, so they do not widen the page on a phone. */
	.scroller {
		position: relative;
	}
	.tick {
		width: 32px;
	}
	.grp th {
		background: var(--sunk);
		color: var(--text);
		font-size: 13px;
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
		overflow-wrap: anywhere;
	}
	td {
		vertical-align: top;
	}
	.type {
		font-size: 13px;
		font-weight: 500;
	}
	.val {
		min-width: 220px;
		max-width: 560px;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}
	.tags:not(:empty) {
		margin-top: var(--space-1);
	}
	.tags a {
		text-decoration: none;
	}
	.tags a:hover {
		text-decoration: underline;
	}
	.num {
		text-align: right;
	}
	.nowrap {
		white-space: nowrap;
	}
	.ttl {
		font-size: 13px;
	}
	.notes {
		max-width: 260px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-1);
		white-space: nowrap;
	}
	.fp-ibtn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.gone :global(.rv),
	.gone .ttl,
	.gone .notes {
		text-decoration: line-through;
		color: var(--muted);
	}
	.pending td:first-child {
		box-shadow: inset 2px 0 0 var(--acc-ink);
	}
	.gone td:first-child {
		box-shadow: inset 2px 0 0 var(--error);
	}
	.issues {
		margin: var(--space-1) 0 0 var(--space-5);
		overflow-wrap: anywhere;
	}
	.ttl-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.lbl {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.lbl :global(.fp-field) {
		width: 100%;
	}
	.bad {
		color: var(--error-ink);
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
