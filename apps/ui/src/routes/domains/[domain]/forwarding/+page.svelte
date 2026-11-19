<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { ChevronDown } from '@lucide/svelte';
	import type { ApiError, RedirectType, UrlForward, WriteResult } from '$lib/api/porkbun';
	import { AsOf, EmptyState, Notice } from '$lib/design/components';
	import { PorkbunNotice, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import {
		REDIRECT_TYPES,
		checkForward,
		describeForward,
		forwardSource,
		redirectLabel
	} from '$lib/porkbun/forwarding/forwards';
	import { domainHref } from '$lib/porkbun/tabs';
	import type { ReviewChange } from '$lib/porkbun/types';

	let { data } = $props();

	const domain = $derived(data.domain?.domain ?? '');
	const base = $derived(`/api/porkbun/domains/${encodeURIComponent(domain)}/forwards`);

	let subdomain = $state('');
	let location = $state('');
	let redirectType = $state<RedirectType>('301');
	let includePath = $state(true);
	let wildcard = $state(false);

	const hint = $derived(REDIRECT_TYPES.find((t) => t.value === redirectType)?.hint ?? '');
	const draft = $derived(checkForward({ subdomain, location, redirectType, includePath, wildcard }));
	let showProblem = $state(false);

	let review = $state(false);
	let target = $state<UrlForward | null>(null);
	let busy = $state(false);
	let failure = $state<ApiError | null>(null);
	let refreshing = $state(false);

	const changes = $derived<ReviewChange[]>(
		target
			? [
					{
						kind: 'delete',
						title: forwardSource(target, domain),
						before: describeForward(target, domain)
					}
				]
			: draft.ok
				? [
						{
							kind: 'create',
							title: forwardSource(draft.value, domain),
							after: describeForward(draft.value, domain)
						}
					]
				: []
	);

	function openAdd() {
		showProblem = true;
		if (!draft.ok) return;
		target = null;
		failure = null;
		review = true;
	}

	function openDelete(forward: UrlForward) {
		target = forward;
		failure = null;
		review = true;
	}

	async function send(url: string, init: RequestInit): Promise<WriteResult> {
		const res = await fetch(url, init);
		const body = await res.json().catch(() => null);
		if (body && 'ok' in body) return body as WriteResult;
		const error: ApiError = body?.error ?? {
			code: 'UNREACHABLE',
			message: 'The answer from this UI could not be read.',
			retryable: true
		};
		return { ok: false, error };
	}

	async function apply() {
		busy = true;
		failure = null;
		try {
			const result = target
				? await send(`${base}/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
				: await send(base, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(draft.ok ? draft.value : {})
					});
			if (!result.ok) {
				failure = result.error;
				return;
			}
			review = false;
			if (!target) {
				subdomain = '';
				location = '';
				showProblem = false;
			}
			await invalidateAll();
		} catch {
			failure = { code: 'UNREACHABLE', message: 'This UI could not be reached.', retryable: true };
		} finally {
			busy = false;
		}
	}

	async function refresh() {
		refreshing = true;
		try {
			await fetch(`${base}?force`);
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
</script>

<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">URL forwarding</h2></div>
	<p class="t-body t-muted">
		Porkbun answers web requests for an address on this domain with a redirect to another website.
	</p>

	<PorkbunNotice error={data.error} />

	{#if data.forwards}
		<p class="t-ui t-muted asof">
			<AsOf at={data.forwards.fetchedAt} timeZone={data.timeZone} stale={data.forwards.stale} />
			<button type="button" class="fp-btn fp-btn--quiet" onclick={refresh} disabled={refreshing}>
				{refreshing ? 'Refreshing…' : 'Refresh'}
			</button>
		</p>

		{#if data.forwards.data.length === 0}
			<EmptyState
				title="No forwards"
				line="Add one below to send an address on this domain to another website."
			/>
		{:else}
			<div class="fp-panel fp-table__wrap">
				<table class="fp-table">
					<caption class="visually-hidden">URL forwards of {domain}</caption>
					<thead>
						<tr>
							<th scope="col">From</th>
							<th scope="col">To</th>
							<th scope="col">Type</th>
							<th scope="col">Path</th>
							<th scope="col"><span class="visually-hidden">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each data.forwards.data as forward (forward.id)}
							<tr>
								<td class="t-mono from">
									{forwardSource(forward, domain)}
									{#if forward.wildcard}<span class="fp-tag">+ subdomains</span>{/if}
								</td>
								<td class="t-mono to">{forward.location}</td>
								<td><span class="fp-tag fp-tag--acc">{redirectLabel(forward.redirectType)}</span></td>
								<td class="t-ui">{forward.includePath ? 'kept' : 'dropped'}</td>
								<td>
									<ScopeGate status={data.porkbun} scope="dns" showReason={false}>
										{#snippet children({ disabled, reason })}
											<button
												type="button"
												class="fp-btn fp-btn--quiet"
												{disabled}
												title={reason}
												onclick={() => openDelete(forward)}
												aria-label="Delete the forward from {forwardSource(forward, domain)}">Delete</button
											>
										{/snippet}
									</ScopeGate>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<div class="fp-panel add">
			<h3 class="t-title-2">Add a forward</h3>
			<form
				class="add__form"
				onsubmit={(e) => {
					e.preventDefault();
					openAdd();
				}}
			>
				<div class="field">
					<label class="t-ui" for="fw-sub">Subdomain</label>
					<span class="fp-field">
						<input
							id="fw-sub"
							bind:value={subdomain}
							class="t-mono"
							placeholder="www"
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
						/>
						<span class="t-mono t-muted">.{domain}</span>
					</span>
					<p class="t-caption">Leave empty for {domain} itself.</p>
				</div>
				<div class="field field--wide">
					<label class="t-ui" for="fw-to">Send visitors to</label>
					<span class="fp-field">
						<input
							id="fw-to"
							bind:value={location}
							class="t-mono"
							placeholder="https://example.org/"
							autocomplete="off"
							spellcheck="false"
							inputmode="url"
						/>
					</span>
				</div>
				<div class="field">
					<label class="t-ui" for="fw-type">Type</label>
					<span class="fp-select">
						<select id="fw-type" bind:value={redirectType}>
							{#each REDIRECT_TYPES as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
						</select>
						<ChevronDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
					</span>
					<p class="t-caption">{hint}</p>
				</div>
				<div class="field">
					<label class="check t-ui"><input type="checkbox" bind:checked={includePath} /> Keep the path</label>
					<p class="t-caption">example.com/a becomes the target plus /a.</p>
					<label class="check t-ui"
						><input type="checkbox" bind:checked={wildcard} /> Every subdomain too</label
					>
					<p class="t-caption">Also covers names under this one.</p>
				</div>
				<div class="add__go">
					<ScopeGate status={data.porkbun} scope="dns">
						{#snippet children({ disabled })}
							<button type="submit" class="fp-btn fp-btn--primary" {disabled}>Review forward</button>
						{/snippet}
					</ScopeGate>
				</div>
			</form>
			{#if showProblem && !draft.ok}
				<div class="problem" role="alert"><Notice kind="warning">{draft.message}</Notice></div>
			{/if}
		</div>
	{:else if !data.error}
		<p class="t-ui t-muted">
			Forwards could not be loaded. <a href={domainHref(domain)}>Back to the overview</a>
		</p>
	{/if}
</section>

<ReviewDialog
	bind:open={review}
	title={target ? 'Delete this forward' : 'Add this forward'}
	intro={target
		? 'Visitors to this address will stop being redirected.'
		: 'Porkbun starts redirecting this address as soon as the change is applied.'}
	{changes}
	destructive={target !== null}
	applyLabel={target ? 'Delete forward' : 'Add forward'}
	{busy}
	error={failure}
	onapply={apply}
/>

<style>
	.asof {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.from,
	.to {
		overflow-wrap: anywhere;
	}
	.from {
		white-space: nowrap;
	}
	.add {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.add__form {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: var(--space-4);
		align-items: start;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.field--wide {
		grid-column: span 2;
	}
	.field .fp-field,
	.field .fp-select {
		width: 100%;
	}
	.field .fp-select select {
		width: 100%;
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.add__go {
		grid-column: 1 / -1;
	}
	@media (max-width: 760px) {
		.field--wide {
			grid-column: auto;
		}
	}
</style>
