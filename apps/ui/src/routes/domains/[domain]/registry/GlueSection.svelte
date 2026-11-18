<script lang="ts">
	import type { ApiError, GlueHost, PorkbunStatus, WriteResult } from '$lib/api/porkbun';
	import { AsOf, EmptyState, Notice } from '$lib/design/components';
	import { PorkbunNotice, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import { call, domainApi } from '$lib/porkbun/registry/api';
	import type { Part } from '$lib/porkbun/registry/types';
	import { checkGlueHost, checkGlueIps } from '$lib/porkbun/registry/validate';
	import type { ReviewChange } from '$lib/porkbun/types';

	type Props = {
		domain: string;
		status: PorkbunStatus;
		timeZone: string;
		part: Part<GlueHost[]>;
		onchanged: () => Promise<void>;
	};
	let { domain, status, timeZone, part, onchanged }: Props = $props();

	const hosts = $derived(part.value?.data ?? []);
	const short = (fqdn: string) => (fqdn.endsWith(`.${domain}`) ? fqdn.slice(0, -domain.length - 1) : fqdn);
	const ipsOf = (g: GlueHost) => [...g.v4, ...g.v6];

	// The add/edit form.
	let form = $state<{ mode: 'create' | 'edit'; host: string; ips: string } | null>(null);
	let touched = $state(false);
	const hostCheck = $derived(form ? checkGlueHost(form.host, domain) : null);
	const ipsCheck = $derived(form ? checkGlueIps(form.ips) : null);

	function startAdd() {
		form = { mode: 'create', host: '', ips: '' };
		touched = false;
		done = null;
	}
	function startEdit(g: GlueHost) {
		form = { mode: 'edit', host: short(g.host), ips: ipsOf(g).join('\n') };
		touched = false;
		done = null;
	}

	// The review step.
	type Pending =
		| { kind: 'create'; host: string; ips: string[] }
		| { kind: 'edit'; host: string; ips: string[]; before: GlueHost }
		| { kind: 'delete'; host: string; before: GlueHost };
	let pending = $state<Pending | null>(null);
	let open = $state(false);
	let applying = $state(false);
	let applyError = $state<ApiError | null>(null);
	let done = $state<{ text: string; warnings: string[] } | null>(null);

	function review() {
		touched = true;
		if (!form || !hostCheck?.ok || !ipsCheck?.ok) return;
		const host = hostCheck.value;
		const before = hosts.find((g) => g.host === `${host}.${domain}`);
		pending =
			form.mode === 'edit' && before
				? { kind: 'edit', host, ips: ipsCheck.value, before }
				: { kind: 'create', host, ips: ipsCheck.value };
		applyError = null;
		open = true;
	}

	function reviewDelete(g: GlueHost) {
		pending = { kind: 'delete', host: short(g.host), before: g };
		applyError = null;
		open = true;
	}

	const changes = $derived.by((): ReviewChange[] => {
		if (!pending) return [];
		const title = `Glue ${pending.host}.${domain}`;
		if (pending.kind === 'create') return [{ kind: 'create', title, after: pending.ips.join(', ') }];
		if (pending.kind === 'edit') {
			return [
				{ kind: 'edit', title, before: ipsOf(pending.before).join(', '), after: pending.ips.join(', ') }
			];
		}
		return [
			{
				kind: 'delete',
				title,
				before: ipsOf(pending.before).join(', '),
				note: 'If the domain uses this host as a nameserver, resolvers can no longer find it once the registry drops the addresses.'
			}
		];
	});

	async function apply() {
		if (!pending) return;
		applying = true;
		applyError = null;
		const p = pending;
		const answer =
			p.kind === 'create'
				? await call<WriteResult>('POST', domainApi(domain, 'glue'), { host: p.host, ips: p.ips })
				: p.kind === 'edit'
					? await call<WriteResult>('PUT', domainApi(domain, 'glue', p.host), { ips: p.ips })
					: await call<WriteResult>('DELETE', domainApi(domain, 'glue', p.host), { confirm: domain });
		applying = false;
		if (!answer.ok) return void (applyError = answer.error);
		if (!answer.data.ok) return void (applyError = answer.data.error);
		const verb = p.kind === 'create' ? 'added' : p.kind === 'edit' ? 'changed' : 'deleted';
		done = { text: `Glue for ${p.host}.${domain} ${verb}.`, warnings: answer.data.warnings };
		open = false;
		form = null;
		await onchanged();
	}
</script>

<section class="fp-section" aria-labelledby="glue-title">
	<div class="fp-section__head">
		<h2 class="t-title-2" id="glue-title">Glue records</h2>
		{#if part.value}<AsOf at={part.value.fetchedAt} {timeZone} stale={part.value.stale} />{/if}
	</div>
	<p class="fp-lede">
		Addresses the registry publishes for nameservers inside this domain, such as ns1.{domain}. Only needed
		when the domain is served by its own nameservers.
	</p>

	{#if done}
		<Notice kind="success">{done.text}</Notice>
		<PorkbunNotice warnings={done.warnings} />
	{/if}

	{#if part.error}
		<PorkbunNotice error={part.error} />
	{:else if part.value}
		{#if hosts.length === 0}
			<EmptyState title="No glue records" line="Nothing is published for nameservers inside this domain." />
		{:else}
			<div class="fp-panel fp-table__wrap scroller">
				<table class="fp-table">
					<caption class="visually-hidden">Glue records of {domain}</caption>
					<thead>
						<tr>
							<th scope="col">Host</th>
							<th scope="col">IPv4</th>
							<th scope="col">IPv6</th>
							<th scope="col"><span class="visually-hidden">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each hosts as g (g.host)}
							<tr>
								<td class="t-mono cell">{g.host}</td>
								<td class="t-mono cell"
									>{#each g.v4 as ip (ip)}<div>{ip}</div>{:else}<span class="t-faint">—</span>{/each}</td
								>
								<td class="t-mono cell"
									>{#each g.v6 as ip (ip)}<div>{ip}</div>{:else}<span class="t-faint">—</span>{/each}</td
								>
								<td class="actions">
									<ScopeGate {status} scope="domains" showReason={false}>
										{#snippet children({ disabled })}
											<button
												class="fp-btn fp-btn--quiet"
												type="button"
												{disabled}
												onclick={() => startEdit(g)}>Edit</button
											>
											<button
												class="fp-btn fp-btn--quiet danger"
												type="button"
												{disabled}
												onclick={() => reviewDelete(g)}>Delete…</button
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

		{#if form}
			<div class="fp-panel form">
				<h3 class="t-ui lbl">
					{form.mode === 'create' ? 'Add a glue record' : `Edit ${form.host}.${domain}`}
				</h3>
				<div class="fields">
					<div class="fld">
						<label class="t-ui" for="glue-host">Host</label>
						<span class="fp-field" class:bad={touched && !hostCheck?.ok}>
							<input
								id="glue-host"
								class="t-mono"
								bind:value={form.host}
								placeholder="ns1"
								disabled={form.mode === 'edit'}
								autocomplete="off"
								spellcheck="false"
							/>
							<span class="t-mono t-faint">.{domain}</span>
						</span>
						{#if touched && hostCheck && !hostCheck.ok}<p class="t-caption err">{hostCheck.message}</p>{/if}
					</div>
					<div class="fld fld--wide">
						<label class="t-ui" for="glue-ips">Addresses, IPv4 or IPv6</label>
						<textarea
							id="glue-ips"
							class="t-mono area"
							rows="3"
							bind:value={form.ips}
							placeholder="192.0.2.1&#10;2001:db8::1"
							spellcheck="false"
							aria-invalid={touched && !ipsCheck?.ok ? 'true' : undefined}
						></textarea>
						{#if touched && ipsCheck && !ipsCheck.ok}<p class="t-caption err">{ipsCheck.message}</p>{/if}
					</div>
				</div>
				<div class="btns">
					<button class="fp-btn" type="button" onclick={() => (form = null)}>Cancel</button>
					<button class="fp-btn fp-btn--primary" type="button" onclick={review}>Review…</button>
				</div>
			</div>
		{:else}
			<p>
				<ScopeGate {status} scope="domains">
					{#snippet children({ disabled })}
						<button class="fp-btn" type="button" {disabled} onclick={startAdd}>Add glue record…</button>
					{/snippet}
				</ScopeGate>
			</p>
		{/if}
	{/if}
</section>

<ReviewDialog
	bind:open
	title={pending?.kind === 'delete'
		? 'Delete glue record'
		: pending?.kind === 'edit'
			? 'Change glue record'
			: 'Add glue record'}
	intro="Porkbun has no rehearsal for glue records, so check the addresses here. Nothing is sent until you apply."
	{changes}
	confirmText={pending?.kind === 'delete' ? domain : null}
	confirmPurpose="to delete the glue record"
	destructive={pending?.kind === 'delete'}
	applyLabel={pending?.kind === 'delete' ? 'Delete' : 'Apply'}
	busy={applying}
	error={applyError}
	onapply={apply}
/>

<style>
	/* Holds the visually hidden labels of the last column, so they do not widen the page on a phone. */
	.scroller {
		position: relative;
	}
	.cell {
		font-size: 13px;
		white-space: nowrap;
	}
	td {
		vertical-align: top;
	}
	.actions {
		text-align: right;
		white-space: nowrap;
	}
	.danger {
		color: var(--error-ink);
	}
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
	}
	.lbl {
		font-weight: 500;
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
	}
	.fld {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.fld--wide {
		flex: 1;
		min-width: min(280px, 100%);
	}
	.fp-field input {
		font-size: 13px;
		min-width: 6ch;
	}
	.bad {
		border-color: var(--error-ink);
	}
	.err {
		color: var(--error-ink);
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
	.area[aria-invalid='true'] {
		border-color: var(--error-ink);
	}
	.btns {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
