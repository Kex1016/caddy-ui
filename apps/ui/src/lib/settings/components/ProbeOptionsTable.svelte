<script lang="ts">
	import { enhance } from '$app/forms';
	import { Notice, Tag } from '$lib/design/components';
	import type { ProbeOptionsRow } from '../types';

	/**
	 * Per-site probe options (docs/settings-and-perf-plan.md §3, monitoring thresholds): skip a site, probe another
	 * path, treat more statuses as up. Each row saves on its own through the page's `?/probeOptions` action; the
	 * collector uses the new options from its next cycle.
	 */
	type Props = { rows: ProbeOptionsRow[] };
	let { rows }: Props = $props();

	let busy = $state<string | null>(null);
	let saved = $state<string | null>(null);
	let error = $state<{ siteId: string; field: string; message: string } | null>(null);
	let filter = $state('');

	const shown = $derived(
		filter.trim() === ''
			? rows
			: rows.filter((r) => r.addresses.some((a) => a.toLowerCase().includes(filter.trim().toLowerCase())))
	);
	const changedCount = $derived(rows.filter((r) => r.skip || r.path || r.upStatuses.length).length);
</script>

<div class="fp-panel probes">
	<div class="probes__bar">
		<p class="t-body t-muted">
			By default a site is probed at its own address and counts as up unless Caddy answers 502, 503 or 504.
			{#if changedCount}<b>{changedCount} {changedCount === 1 ? 'site has' : 'sites have'} own options.</b
				>{/if}
		</p>
		{#if rows.length > 8}
			<span class="fp-field filter">
				<input
					type="search"
					placeholder="Filter sites"
					aria-label="Filter sites"
					bind:value={filter}
					autocomplete="off"
				/>
			</span>
		{/if}
	</div>
	{#if rows.length === 0}
		<p class="t-ui t-muted">No sites in the Caddyfile yet.</p>
	{:else}
		<div class="fp-table__wrap">
			<table class="fp-table">
				<caption class="visually-hidden">Probe options for each site</caption>
				<thead>
					<tr>
						<th scope="col">Site</th>
						<th scope="col">Probe</th>
						<th scope="col">Path</th>
						<th scope="col">Also up</th>
						<th scope="col"><span class="visually-hidden">Save</span></th>
					</tr>
				</thead>
				<tbody>
					{#each shown as r (r.siteId)}
						{@const formId = `probe-${r.siteId}`}
						{@const err = error?.siteId === r.siteId ? error : null}
						<tr data-site={r.label}>
							<td class="site">
								<span class="t-ui">{r.label}</span>
								{#if r.target && !r.skip}<span class="t-mono t-caption target">{r.target}</span>{/if}
							</td>
							<td>
								<label class="t-ui check">
									<input type="checkbox" name="probe" form={formId} checked={!r.skip} />
									<span>Probe <span class="visually-hidden">{r.label}</span></span>
								</label>
							</td>
							<td>
								<span class="fp-field small" class:invalid={err?.field === 'path'}>
									<input
										class="t-mono"
										name="path"
										form={formId}
										value={r.path ?? ''}
										placeholder="/"
										aria-label="Path to probe for {r.label}"
										aria-invalid={err?.field === 'path' ? 'true' : undefined}
										autocomplete="off"
										spellcheck="false"
									/>
								</span>
							</td>
							<td>
								<span class="fp-field small" class:invalid={err?.field === 'upStatuses'}>
									<input
										class="t-mono"
										name="upStatuses"
										form={formId}
										value={r.upStatuses.join(', ')}
										placeholder="e.g. 503"
										inputmode="numeric"
										aria-label="Statuses that also count as up for {r.label}"
										aria-invalid={err?.field === 'upStatuses' ? 'true' : undefined}
										autocomplete="off"
									/>
								</span>
							</td>
							<td class="save">
								<form
									id={formId}
									method="POST"
									action="?/probeOptions"
									use:enhance={() => {
										busy = r.siteId;
										saved = null;
										error = null;
										return async ({ result, update }) => {
											if (result.type === 'failure') {
												error = (result.data?.probeError as typeof error) ?? {
													siteId: r.siteId,
													field: 'siteId',
													message: 'Not saved.'
												};
											} else if (result.type === 'success') {
												saved = r.siteId;
											}
											await update({ reset: false });
											busy = null;
										};
									}}
								>
									<input type="hidden" name="siteId" value={r.siteId} />
									<button class="fp-btn" disabled={busy !== null}>
										{busy === r.siteId ? 'Saving…' : 'Save'}<span class="visually-hidden"> {r.label}</span>
									</button>
									<span aria-live="polite" class="t-ui">
										{#if saved === r.siteId}<Tag kind="success">Saved</Tag>{/if}
									</span>
								</form>
							</td>
						</tr>
						{#if err}
							<tr class="err">
								<td colspan="5"><Notice kind="error">{err.message}</Notice></td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<p class="t-caption">
		Not probed: the site and its upstreams are skipped and show as unknown. Path: probe this path (and query)
		instead of the site’s own, for example <code>/health</code>. Also up: statuses that count as up, for
		example
		<code>503</code> for a maintenance page. Changes apply from the next probe cycle.
	</p>
</div>

<style>
	.probes {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.probes__bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.probes__bar p {
		margin: 0;
		flex: 1 1 20rem;
	}
	.filter {
		max-width: 16rem;
	}
	.site > span {
		display: block;
		overflow-wrap: anywhere;
	}
	.target {
		max-width: 22rem;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		white-space: nowrap;
	}
	.check input {
		accent-color: var(--acc);
	}
	.small {
		min-width: 7rem;
		max-width: 14rem;
	}
	.invalid {
		border-color: var(--error-ink);
	}
	.save form {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
