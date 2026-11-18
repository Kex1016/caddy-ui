<script lang="ts">
	import {
		PORKBUN_NAMESERVERS,
		type ApiError,
		type DryRun,
		type Preflight,
		type PorkbunStatus,
		type WriteResult
	} from '$lib/api/porkbun';
	import { AsOf, Notice, Tag } from '$lib/design/components';
	import { PorkbunNotice, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import PreflightChecks from '$lib/porkbun/registry/PreflightChecks.svelte';
	import { call, domainApi } from '$lib/porkbun/registry/api';
	import type { NameserverRehearsal, Part, PreflightBlocked } from '$lib/porkbun/registry/types';
	import {
		checkNameservers,
		isAtPorkbun,
		isPorkbunDefault,
		sameNameservers
	} from '$lib/porkbun/registry/validate';

	type Props = {
		domain: string;
		status: PorkbunStatus;
		timeZone: string;
		part: Part<string[]>;
		onchanged: () => Promise<void>;
	};
	let { domain, status, timeZone, part, onchanged }: Props = $props();

	const current = $derived(part.value?.data ?? []);
	let editing = $state(false);
	let text = $state('');
	let touched = $state(false);
	const parsed = $derived(checkNameservers(text));
	const unchanged = $derived(parsed.ok && sameNameservers(parsed.value, current));

	function edit(prefill?: readonly string[]) {
		text = (prefill ?? current).join('\n');
		touched = false;
		editing = true;
		done = null;
	}

	let open = $state(false);
	let rehearsal = $state<DryRun | 'running' | null>(null);
	let preflight = $state<Preflight | null>(null);
	let applying = $state(false);
	let applyError = $state<ApiError | null>(null);
	let done = $state<{ warnings: string[] } | null>(null);
	let seq = 0;

	async function review() {
		touched = true;
		if (!parsed.ok || unchanged) return;
		const mine = ++seq;
		preflight = null;
		applyError = null;
		rehearsal = 'running';
		open = true;
		const answer = await call<NameserverRehearsal>('PUT', domainApi(domain, 'nameservers'), {
			ns: parsed.value,
			dryRun: true
		});
		if (mine !== seq) return;
		if (answer.ok) {
			rehearsal = answer.data.dryRun;
			preflight = answer.data.preflight;
		} else rehearsal = { wouldSucceed: false, warnings: [], error: answer.error };
	}

	const anyFailing = (pf: Preflight | null) => (pf?.checks ?? []).some((c) => !c.ok);

	const leaving = $derived(parsed.ok && isAtPorkbun(current) && !isAtPorkbun(parsed.value));
	const arriving = $derived(parsed.ok && !isAtPorkbun(current) && isAtPorkbun(parsed.value));

	async function apply() {
		if (!parsed.ok) return;
		applying = true;
		applyError = null;
		const answer = await call<WriteResult>('PUT', domainApi(domain, 'nameservers'), {
			ns: parsed.value,
			confirm: domain
		});
		applying = false;
		if (!answer.ok) {
			if (
				answer.status === 409 &&
				answer.body &&
				typeof answer.body === 'object' &&
				'preflight' in answer.body
			)
				preflight = (answer.body as PreflightBlocked).preflight;
			applyError = answer.error;
			return;
		}
		if (!answer.data.ok) {
			applyError = answer.data.error;
			return;
		}
		done = { warnings: answer.data.warnings };
		open = false;
		editing = false;
		await onchanged();
	}
</script>

<section class="fp-section" aria-labelledby="ns-title">
	<div class="fp-section__head">
		<h2 class="t-title-2" id="ns-title">Nameservers</h2>
		{#if part.value}<AsOf at={part.value.fetchedAt} {timeZone} stale={part.value.stale} />{/if}
	</div>

	{#if done}
		<Notice kind="success"
			><b>Nameservers changed at the registry.</b> Resolvers can keep using the old ones for a day or two, until
			their caches expire.</Notice
		>
		<PorkbunNotice warnings={done.warnings} />
	{/if}

	{#if part.error}
		<PorkbunNotice error={part.error} />
	{:else if part.value}
		<div class="fp-panel box">
			<p class="tags">
				{#if isPorkbunDefault(current)}<Tag kind="success">Porkbun defaults</Tag>
				{:else if isAtPorkbun(current)}<Tag kind="success">Porkbun</Tag>
				{:else}<Tag kind="warning">elsewhere</Tag>{/if}
			</p>
			<ul class="ns">
				{#each current as n (n)}<li class="t-mono">{n}</li>{/each}
			</ul>
			{#if !isAtPorkbun(current)}
				<p class="t-ui t-muted">
					This domain is delegated to nameservers Porkbun does not run, so the records on the DNS tab are not
					what the world sees. Change records where these nameservers are managed, or point the domain back at
					Porkbun.
				</p>
			{/if}

			{#if editing}
				<div class="form">
					<label class="t-ui lbl" for="ns-text">New nameservers, one per line</label>
					<textarea
						id="ns-text"
						class="t-mono area"
						rows="5"
						spellcheck="false"
						bind:value={text}
						aria-invalid={touched && !parsed.ok ? 'true' : undefined}
						aria-describedby="ns-help"
					></textarea>
					<p id="ns-help" class="t-caption" class:bad={touched && !parsed.ok}>
						{#if touched && !parsed.ok}{parsed.message}{:else if unchanged}These are the nameservers already
							in use.{:else}Between 2 and 13 hostnames.{/if}
					</p>
					<div class="btns">
						<button class="fp-btn fp-btn--quiet" type="button" onclick={() => edit(PORKBUN_NAMESERVERS)}
							>Use Porkbun defaults</button
						>
						<span class="spacer"></span>
						<button class="fp-btn" type="button" onclick={() => (editing = false)}>Cancel</button>
						<button
							class="fp-btn fp-btn--primary"
							type="button"
							disabled={unchanged || (touched && !parsed.ok)}
							onclick={review}>Review change…</button
						>
					</div>
				</div>
			{:else}
				<ScopeGate {status} scope="domains">
					{#snippet children({ disabled })}
						<button class="fp-btn" type="button" {disabled} onclick={() => edit()}>Change nameservers…</button
						>
						{#if !isPorkbunDefault(current)}
							<button
								class="fp-btn fp-btn--quiet"
								type="button"
								{disabled}
								onclick={() => edit(PORKBUN_NAMESERVERS)}>Back to Porkbun defaults…</button
							>
						{/if}
					{/snippet}
				</ScopeGate>
			{/if}
		</div>
	{/if}
</section>

<ReviewDialog
	bind:open
	title="Change nameservers"
	intro="This changes where the whole domain is answered from: web, mail and every other name. Porkbun's safety check and a rehearsal run first; nothing is sent until you apply."
	changes={parsed.ok
		? [
				{
					kind: 'edit',
					title: 'Nameservers',
					before: current.join(', '),
					after: parsed.value.join(', '),
					note: leaving
						? 'The records on the DNS tab stop being what the world sees. Set the same records up at the new provider before you apply.'
						: arriving
							? 'The records on the DNS tab become what the world sees. Check them on the DNS tab before you apply.'
							: undefined
				}
			]
		: []}
	dryRun={rehearsal}
	blocked={preflight && preflight.blockers.length > 0
		? "Porkbun's safety check found a blocker, listed above. Fix it first."
		: null}
	confirmText={domain}
	confirmPurpose="to change its nameservers"
	destructive
	applyLabel="Change nameservers"
	busy={applying}
	error={applyError}
	onapply={apply}
	oncancel={() => (seq += 1)}
>
	{#if preflight && anyFailing(preflight)}
		<PreflightChecks {preflight} onlyFailing summary={false} />
	{/if}
</ReviewDialog>

<style>
	.box {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
	}
	.tags {
		display: flex;
		gap: var(--space-2);
	}
	.ns {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 13px;
		line-height: 22px;
		overflow-wrap: anywhere;
	}
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		max-width: 560px;
	}
	.lbl {
		font-weight: 500;
	}
	.area {
		width: 100%;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sunk);
		color: var(--text);
		font-size: 13px;
		line-height: 20px;
		resize: vertical;
	}
	.area[aria-invalid='true'],
	.bad {
		border-color: var(--error-ink);
		color: var(--error-ink);
	}
	.btns {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.spacer {
		flex: 1;
	}
</style>
