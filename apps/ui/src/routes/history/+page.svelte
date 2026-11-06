<script lang="ts">
	import { enhance } from '$app/forms';
	import { EmptyState, Notice, PageHero, Tag } from '$lib/design/components';
	import { diffLines, diffStats, hunks } from '$lib/diff';
	import { formatDateTime, formatNumber } from '$lib/format';

	let { data, form } = $props();

	const lines = $derived(data.selected && data.base ? diffLines(data.base.text, data.selected.text) : null);
	const stats = $derived(lines ? diffStats(lines) : null);
	const shown = $derived(lines ? hunks(lines) : []);
	const isCurrent = $derived(data.selected?.hash === data.currentHash);
	let busy = $state(false);

	const href = (rev: number, against = data.against) =>
		`?rev=${rev}${against === 'current' ? '&against=current' : ''}`;
</script>

<PageHero
	kicker="Caddyfile"
	title="History"
	lede="Every version of the Caddyfile this UI has applied or seen on disk, newest first. Restoring one validates it with Caddy, writes it and reloads."
/>

{#if form?.message}
	<section class="fp-section">
		<Notice kind={'restored' in form ? 'success' : 'error'}>{form.message}</Notice>
	</section>
{/if}
{#if data.externalChange}
	<section class="fp-section">
		<Notice kind="warning">
			<b>Edited outside the UI.</b> The Caddyfile changed on disk at {formatDateTime(
				data.externalChange.at,
				data.timeZone
			)}.
			{#if data.externalChange.revisionId}It is kept as
				<a href={href(data.externalChange.revisionId)}>revision #{data.externalChange.revisionId}</a>.{/if}
		</Notice>
	</section>
{/if}
{#if data.drift.state === 'file_differs'}
	<section class="fp-section">
		<Notice kind="warning"><b>Not applied.</b> {data.drift.message}.</Notice>
	</section>
{:else if data.drift.state === 'unknown'}
	<section class="fp-section">
		<Notice>Cannot compare with the running config: {data.drift.message}.</Notice>
	</section>
{/if}

{#if data.revisions.length === 0}
	<section class="fp-section">
		<EmptyState title="No revisions yet" line="Each change applied from this UI is kept here." />
	</section>
{:else}
	<section class="fp-section fp-two history">
		<div class="fp-panel fp-table__wrap">
			<table class="fp-table">
				<caption class="visually-hidden">Revisions of the Caddyfile, newest first</caption>
				<thead>
					<tr>
						<th scope="col" class="num">#</th>
						<th scope="col">Change</th>
						<th scope="col" class="num">Lines</th>
					</tr>
				</thead>
				<tbody>
					{#each data.revisions as rev (rev.id)}
						<tr aria-current={rev.id === data.selected?.id ? 'true' : undefined}>
							<td class="num"><a href={href(rev.id)}>#{rev.id}</a></td>
							<td>
								<div class="change">
									<span>{rev.note || 'Applied'}</span>
									{#if rev.hash === data.currentHash}<Tag kind="acc">on disk</Tag>{/if}
								</div>
								<div class="t-ui t-muted">{rev.author} · {formatDateTime(rev.ts, data.timeZone)}</div>
							</td>
							<td class="num">{formatNumber(rev.lines)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.selected}
			<div class="fp-panel detail">
				<div class="detail__head">
					<h2 class="t-title-2">Revision #{data.selected.id}</h2>
					<p class="t-ui t-muted">
						{formatDateTime(data.selected.ts, data.timeZone)} · {data.selected.author}{data.selected.note
							? ` · ${data.selected.note}`
							: ''}
					</p>
				</div>

				<div class="detail__bar">
					<nav class="fp-seg" aria-label="Compare with">
						<a
							href={href(data.selected.id, 'previous')}
							aria-current={data.against === 'previous' ? 'page' : undefined}>Previous revision</a
						>
						<a
							href={href(data.selected.id, 'current')}
							aria-current={data.against === 'current' ? 'page' : undefined}>File on disk</a
						>
					</nav>
					<form
						method="POST"
						action="?/restore"
						use:enhance={() => {
							busy = true;
							return async ({ update }) => {
								await update();
								busy = false;
							};
						}}
					>
						<input type="hidden" name="id" value={data.selected.id} />
						<button class="fp-btn fp-btn--primary" disabled={busy || isCurrent} type="submit">
							{busy ? 'Restoring…' : isCurrent ? 'This is on disk' : 'Restore and reload'}
						</button>
					</form>
				</div>

				{#if !data.base}
					<p class="t-ui t-muted">
						This is the oldest kept revision, so there is nothing before it to compare with.
					</p>
					<pre class="code">{data.selected.text}</pre>
				{:else if stats && stats.added + stats.removed === 0}
					<p class="t-ui t-muted">Identical to {data.base.label}.</p>
				{:else if stats}
					<p class="t-ui t-muted">
						Compared with {data.base.label}: <span class="add-ink">+{stats.added}</span>
						<span class="del-ink">−{stats.removed}</span> lines.
					</p>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div class="diff" role="table" aria-label="Line differences" tabindex="0">
						{#each shown as hunk, h (h)}
							{#if hunk.skippedBefore}
								<div class="diff__skip" role="row">
									<span role="cell">⋯ {hunk.skippedBefore} unchanged lines</span>
								</div>
							{/if}
							{#each hunk.lines as line, k (k)}
								<div class="diff__row diff__row--{line.kind}" role="row">
									<span class="diff__no" role="cell">{line.oldLine ?? ''}</span>
									<span class="diff__no" role="cell">{line.newLine ?? ''}</span>
									<span
										class="diff__sign"
										role="cell"
										aria-label={line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : 'unchanged'}
										>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span
									>
									<span class="diff__text" role="cell">{line.text}</span>
								</div>
							{/each}
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</section>
{/if}

<style>
	.history {
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
	}
	@media (max-width: 860px) {
		.history {
			grid-template-columns: 1fr;
		}
	}
	.change {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
	tr[aria-current] td {
		background: var(--raised);
	}
	.detail {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
	.detail__bar {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		align-items: center;
		justify-content: space-between;
	}
	.code,
	.diff {
		font: 400 13px/20px var(--font-mono);
		background: var(--sunk);
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-lg);
		overflow-x: auto;
		max-height: 70vh;
		overflow-y: auto;
	}
	.code {
		margin: 0;
		padding: var(--space-3);
		tab-size: 4;
	}
	.diff__row,
	.diff__skip {
		display: grid;
		grid-template-columns: 3.5ch 3.5ch 2ch 1fr;
		white-space: pre;
		tab-size: 4;
	}
	.diff__skip {
		grid-template-columns: 1fr;
		padding: 0 var(--space-3);
		color: var(--faint);
	}
	.diff__no {
		text-align: right;
		padding-right: 0.5ch;
		color: var(--faint);
		user-select: none;
	}
	.diff__sign {
		text-align: center;
		user-select: none;
	}
	.diff__row--add {
		background: var(--success-soft);
	}
	.diff__row--del {
		background: var(--error-soft);
	}
	.add-ink {
		color: var(--success-ink, var(--success));
	}
	.del-ink {
		color: var(--error-ink, var(--error));
	}
</style>
