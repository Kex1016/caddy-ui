<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { ApiError, Cached, DryRun, RestoreResult, WriteResult, ZoneDiff } from '$lib/api/porkbun';
	import { AsOf, EmptyState, Notice, Tag } from '$lib/design/components';
	import { formatDateTime } from '$lib/format';
	import { PorkbunNotice, RecordValue, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import { call, domainApi } from '$lib/porkbun/registry/api';
	import { reasonLabel, recordTitle, recordValue } from '$lib/porkbun/registry/history';
	import type { RestoreRehearsal } from '$lib/porkbun/registry/types';
	import type { ReviewChange } from '$lib/porkbun/types';

	let { data } = $props();
	const domain = $derived(data.domain?.domain ?? '');
	const points = $derived(data.history?.data ?? []);

	const when = (iso: string) => {
		const ts = Date.parse(iso);
		return Number.isNaN(ts) ? '—' : formatDateTime(ts, data.timeZone);
	};

	// ── Refresh ──────────────────────────────────────────────────────────────────────────────────────────
	let refreshing = $state(false);
	async function refresh() {
		refreshing = true;
		await call('GET', `${domainApi(domain, 'history')}?force`);
		diffs = {};
		await invalidateAll();
		refreshing = false;
	}

	// ── Compare ──────────────────────────────────────────────────────────────────────────────────────────
	let comparing = $state<number | null>(null);
	let diffs = $state<Record<number, ZoneDiff | ApiError | 'loading'>>({});
	const isDiff = (v: unknown): v is ZoneDiff => !!v && typeof v === 'object' && 'inSync' in v;

	async function loadDiff(id: number): Promise<ZoneDiff | ApiError> {
		const answer = await call<Cached<ZoneDiff>>('GET', `${domainApi(domain, 'history', id, 'diff')}?force`);
		const value = answer.ok ? answer.data.data : answer.error;
		diffs[id] = value;
		return value;
	}

	function toggleCompare(id: number) {
		comparing = comparing === id ? null : id;
		if (comparing !== null && diffs[id] === undefined) {
			diffs[id] = 'loading';
			void loadDiff(id);
		}
	}

	// ── Restore ──────────────────────────────────────────────────────────────────────────────────────────
	let reviewOpen = $state(false);
	let target = $state<{ id: number; undo: boolean } | null>(null);
	let prune = $state(false);
	let diff = $state<ZoneDiff | null>(null);
	let diffError = $state<ApiError | null>(null);
	let rehearsal = $state<DryRun | 'running' | null>(null);
	let rehearsed = $state<RestoreResult | null>(null);
	let applying = $state(false);
	let applyError = $state<ApiError | null>(null);
	let outcome = $state<{ from: number; undo: boolean; result: RestoreResult; warnings: string[] } | null>(
		null
	);
	let seq = 0;

	async function rehearse() {
		if (!target) return;
		const mine = ++seq;
		const id = target.id;
		rehearsal = 'running';
		rehearsed = null;
		const [d, r] = await Promise.all([
			diff ? Promise.resolve(diff) : loadDiff(id),
			call<RestoreRehearsal>('POST', domainApi(domain, 'history', id, 'restore'), { dryRun: true, prune })
		]);
		if (mine !== seq) return;
		if (isDiff(d)) diff = d;
		else diffError = d;
		if (r.ok) {
			rehearsal = r.data.dryRun;
			rehearsed = r.data.result;
		} else {
			rehearsal = { wouldSucceed: false, warnings: [], error: r.error };
		}
	}

	function openRestore(id: number, undo = false) {
		target = { id, undo };
		prune = undo;
		diff = null;
		diffError = null;
		applyError = null;
		reviewOpen = true;
		void rehearse();
	}

	const changes = $derived.by((): ReviewChange[] => {
		if (!diff) return [];
		const out: ReviewChange[] = diff.missing.map((r) => ({
			kind: 'create',
			title: recordTitle(r),
			after: recordValue(r)
		}));
		if (prune) {
			for (const r of diff.extra) out.push({ kind: 'delete', title: recordTitle(r), before: recordValue(r) });
		}
		return out;
	});

	const nothingToDo = $derived.by((): string | null => {
		if (!diff) return null;
		if (diff.inSync) return 'The zone already matches this restore point.';
		if (!prune && diff.missing.length === 0) {
			return 'No record of this restore point is missing, so there is nothing to add back. Choose "Also delete newer records" to remove the records added since.';
		}
		return null;
	});

	const failedLines = $derived(
		(rehearsed?.failed ?? []).map((f) => `${f.type} ${f.name} can not be restored: ${f.reason}`)
	);

	async function apply() {
		if (!target) return;
		applying = true;
		applyError = null;
		const answer = await call<WriteResult<RestoreResult>>(
			'POST',
			domainApi(domain, 'history', target.id, 'restore'),
			prune ? { prune, confirm: domain } : { prune }
		);
		applying = false;
		if (!answer.ok) {
			applyError = answer.error;
			return;
		}
		if (!answer.data.ok) {
			applyError = answer.data.error;
			return;
		}
		outcome = {
			from: target.id,
			undo: target.undo,
			result: answer.data.data,
			warnings: answer.data.warnings
		};
		reviewOpen = false;
		diffs = {};
		comparing = null;
		await invalidateAll();
	}
</script>

<section class="fp-section">
	<div class="fp-section__head">
		<h2 class="t-title-2">Restore points</h2>
		{#if data.history}
			<span class="head-end">
				<AsOf at={data.history.fetchedAt} timeZone={data.timeZone} stale={data.history.stale} />
				<button class="fp-btn fp-btn--quiet" type="button" onclick={refresh} disabled={refreshing}
					>{refreshing ? 'Refreshing…' : 'Refresh'}</button
				>
			</span>
		{/if}
	</div>
	<p class="fp-lede">
		Porkbun saves the zone's records before the first change in each hour, and before every import and
		restore. Restoring adds back the records that are missing since then. With "Also delete newer records" it
		also removes what was added, so the zone is exactly as it was. Every restore saves the state before it as
		a new point, so a restore can be undone.
	</p>

	{#if outcome}
		<Notice kind={outcome.result.failed.length > 0 ? 'warning' : 'success'}>
			<p>
				<b>{outcome.undo ? 'Undone.' : `Restored from point ${outcome.from}.`}</b>
				{outcome.result.restored} record{outcome.result.restored === 1 ? '' : 's'} added back, {outcome.result
					.removed} removed.
			</p>
			{#if outcome.result.failed.length > 0}
				<p>Porkbun could not restore these, so add them again by hand on the DNS tab:</p>
				<ul class="failed">
					{#each outcome.result.failed as f, i (i)}
						<li><span class="t-mono">{f.type} {f.name}</span>: {f.reason}</li>
					{/each}
				</ul>
			{/if}
			{#if outcome.result.previousStateSavedAs !== null}
				<p class="undo">
					The zone as it was before is saved as point {outcome.result.previousStateSavedAs}.
					<ScopeGate status={data.porkbun} scope="dns" showReason={false}>
						{#snippet children({ disabled })}
							<button
								class="fp-btn"
								type="button"
								{disabled}
								onclick={() => openRestore(outcome!.result.previousStateSavedAs!, true)}
								>Undo this {outcome!.undo ? 'undo' : 'restore'}…</button
							>
						{/snippet}
					</ScopeGate>
				</p>
			{/if}
		</Notice>
		<PorkbunNotice warnings={outcome.warnings} />
	{/if}

	{#if data.historyError}
		<PorkbunNotice error={data.historyError} />
	{:else if data.history && points.length === 0}
		<EmptyState
			title="No restore points yet"
			line="Porkbun takes the first one before the next change to this domain's DNS records."
		/>
	{:else if data.history}
		<div class="fp-panel fp-table__wrap scroller">
			<table class="fp-table">
				<caption class="visually-hidden">Restore points of {domain}, newest first</caption>
				<thead>
					<tr>
						<th scope="col">Taken</th>
						<th scope="col">Why</th>
						<th scope="col" class="num">Records</th>
						<th scope="col">Compared with now</th>
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each points as point (point.id)}
						{@const d = diffs[point.id]}
						<tr>
							<td class="nowrap">{when(point.takenAt)}</td>
							<td>
								{reasonLabel(point.reason)}
								<span class="t-caption t-faint">· point {point.id}</span>
							</td>
							<td class="num t-mono">{point.recordCount}</td>
							<td>
								{#if point.matchesLive}<Tag kind="success">matches the zone</Tag>{:else}<Tag>differs</Tag
									>{/if}
							</td>
							<td class="actions">
								<button
									class="fp-btn fp-btn--quiet"
									type="button"
									aria-expanded={comparing === point.id}
									aria-controls="diff-{point.id}"
									onclick={() => toggleCompare(point.id)}>Compare</button
								>
								<ScopeGate status={data.porkbun} scope="dns" showReason={false}>
									{#snippet children({ disabled })}
										<button
											class="fp-btn"
											type="button"
											disabled={disabled || point.matchesLive}
											title={point.matchesLive ? 'The zone already matches this point' : undefined}
											onclick={() => openRestore(point.id)}>Restore…</button
										>
									{/snippet}
								</ScopeGate>
							</td>
						</tr>
						{#if comparing === point.id}
							<tr class="diff-row" id="diff-{point.id}">
								<td colspan="5">
									{#if d === 'loading' || d === undefined}
										<p class="t-ui t-muted" role="status">Comparing with the live zone…</p>
									{:else if isDiff(d)}
										{#if d.inSync}
											<p class="t-ui">The live zone matches this restore point.</p>
										{:else}
											<div class="diff">
												<div>
													<h3 class="t-ui diff__title">
														Missing now <span class="t-caption"
															>({d.missing.length}): a restore adds these back</span
														>
													</h3>
													{#if d.missing.length === 0}<p class="t-ui t-muted">None.</p>{/if}
													<ul class="recs">
														{#each d.missing as r, i (i)}
															<li>
																<span class="t-mono">{recordTitle(r)}</span>
																<RecordValue type={r.type} content={r.content} prio={r.prio} />
															</li>
														{/each}
													</ul>
												</div>
												<div>
													<h3 class="t-ui diff__title">
														Added since <span class="t-caption"
															>({d.extra.length}): removed only with "Also delete newer records"</span
														>
													</h3>
													{#if d.extra.length === 0}<p class="t-ui t-muted">None.</p>{/if}
													<ul class="recs">
														{#each d.extra as r, i (i)}
															<li>
																<span class="t-mono">{recordTitle(r)}</span>
																<RecordValue type={r.type} content={r.content} prio={r.prio} />
															</li>
														{/each}
													</ul>
												</div>
											</div>
										{/if}
									{:else}
										<PorkbunNotice error={d} />
									{/if}
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<ReviewDialog
	bind:open={reviewOpen}
	title={target?.undo ? `Undo: restore point ${target.id}` : `Restore point ${target?.id ?? ''}`}
	intro={target?.undo
		? 'This puts the zone back exactly as it was before the restore: records the restore added back are deleted, and records it removed come back.'
		: 'Porkbun checks the restore first without changing anything. Nothing is sent until you apply.'}
	{changes}
	dryRun={rehearsal}
	warnings={failedLines}
	blocked={nothingToDo}
	confirmText={prune ? domain : null}
	confirmPurpose={prune ? 'to delete the records added since this point' : undefined}
	destructive={prune}
	applyLabel={target?.undo ? 'Undo' : prune ? 'Restore and delete' : 'Restore'}
	busy={applying}
	error={applyError}
	onapply={apply}
	oncancel={() => (seq += 1)}
>
	<label class="prune t-ui">
		<input type="checkbox" bind:checked={prune} disabled={target?.undo} onchange={rehearse} />
		<span
			><b>Also delete newer records</b>
			<span class="t-muted"
				>Removes the {diff?.extra.length ?? ''} record{diff?.extra.length === 1 ? '' : 's'} added since this point,
				so the zone is exactly as it was{target?.undo ? '. An undo always does this.' : '.'}</span
			></span
		>
	</label>
	{#if diffError}<PorkbunNotice error={diffError} />{/if}
	{#if diff && changes.length === 0 && !nothingToDo}
		<p class="t-ui t-muted">No records change.</p>
	{/if}
</ReviewDialog>

<style>
	/* Holds the visually hidden labels of the last column, so they do not widen the page on a phone. */
	.scroller {
		position: relative;
	}
	.head-end {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-3);
	}
	.nowrap {
		white-space: nowrap;
	}
	.num {
		text-align: right;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
		white-space: nowrap;
	}
	td {
		vertical-align: top;
	}
	.diff-row td {
		background: var(--sunk);
	}
	.diff {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
		gap: var(--space-5);
	}
	.diff__title {
		font-weight: 500;
		margin-bottom: var(--space-2);
	}
	.recs {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.recs li {
		display: flex;
		flex-direction: column;
		gap: 2px;
		overflow-wrap: anywhere;
	}
	.recs li > .t-mono {
		font-size: 13px;
	}
	.failed {
		margin: var(--space-1) 0 0 var(--space-5);
	}
	.undo {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		margin-top: var(--space-2);
	}
	.prune {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		cursor: pointer;
	}
	.prune input {
		margin-top: 3px;
	}
	.prune > span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
</style>
