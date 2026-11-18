<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import type {
		ApiError,
		DnssecInput,
		DnssecRecord,
		Preflight,
		PorkbunStatus,
		WriteResult
	} from '$lib/api/porkbun';
	import { AsOf, EmptyState, Notice } from '$lib/design/components';
	import { PorkbunNotice, RecordValue, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import PreflightChecks from '$lib/porkbun/registry/PreflightChecks.svelte';
	import { call, domainApi } from '$lib/porkbun/registry/api';
	import type { DnssecCheck, Part, PreflightBlocked } from '$lib/porkbun/registry/types';
	import {
		DNSSEC_ALGORITHMS,
		DS_DIGEST_TYPES,
		algorithmName,
		checkDnssec,
		digestTypeName,
		parseDsText
	} from '$lib/porkbun/registry/validate';
	import type { ReviewChange } from '$lib/porkbun/types';

	type Props = {
		domain: string;
		status: PorkbunStatus;
		timeZone: string;
		part: Part<DnssecRecord[]>;
		/** Whether the domain's nameservers are Porkbun's, for the advice under the table. */
		atPorkbun: boolean | null;
		onchanged: () => Promise<void>;
	};
	let { domain, status, timeZone, part, atPorkbun, onchanged }: Props = $props();

	const records = $derived(part.value?.data ?? []);
	const usable = Object.entries(DNSSEC_ALGORITHMS).filter(([, a]) => !a.retired);

	const blank = (): Record<keyof DnssecInput, string> => ({
		keyTag: '',
		alg: '13',
		digestType: '2',
		digest: '',
		maxSigLife: '',
		keyDataFlags: '',
		keyDataProtocol: '',
		keyDataAlgo: '',
		keyDataPubKey: ''
	});
	let form = $state<Record<keyof DnssecInput, string> | null>(null);
	let pasted = $state('');
	let touched = $state(false);
	const checked = $derived(form ? checkDnssec(form) : null);
	const fieldError = (k: keyof DnssecInput) =>
		touched && checked && !checked.ok ? (checked.fields[k] ?? null) : null;

	function fromPaste() {
		const ds = parseDsText(pasted);
		if (ds && form) Object.assign(form, ds);
	}

	// The review step.
	type Pending = { kind: 'create'; value: DnssecInput } | { kind: 'delete'; record: DnssecRecord };
	let pending = $state<Pending | null>(null);
	let open = $state(false);
	let checking = $state(false);
	let preflight = $state<Preflight | null>(null);
	let checkError = $state<ApiError | null>(null);
	let applying = $state(false);
	let applyError = $state<ApiError | null>(null);
	let done = $state<{ text: string; warnings: string[] } | null>(null);
	let seq = 0;

	async function reviewAdd() {
		touched = true;
		if (!checked?.ok) return;
		const mine = ++seq;
		pending = { kind: 'create', value: checked.value };
		preflight = null;
		checkError = null;
		applyError = null;
		checking = true;
		open = true;
		const answer = await call<DnssecCheck>('POST', domainApi(domain, 'dnssec'), {
			...checked.value,
			check: true
		});
		if (mine !== seq) return;
		checking = false;
		if (answer.ok) preflight = answer.data.preflight;
		else checkError = answer.error;
	}

	function reviewDelete(record: DnssecRecord) {
		seq += 1;
		pending = { kind: 'delete', record };
		preflight = null;
		checkError = null;
		applyError = null;
		checking = false;
		open = true;
	}

	const describe = (r: Pick<DnssecRecord, 'keyTag' | 'alg' | 'digestType' | 'digest'>) =>
		`${r.keyTag} ${r.alg} ${r.digestType} ${r.digest}`;

	const changes = $derived.by((): ReviewChange[] => {
		if (!pending) return [];
		if (pending.kind === 'create') {
			const v = pending.value;
			return [
				{
					kind: 'create',
					title: `DS ${domain}`,
					after: describe(v),
					note: `Key tag ${v.keyTag}, ${algorithmName(v.alg)}, ${digestTypeName(v.digestType)}`
				}
			];
		}
		return [{ kind: 'delete', title: `DS ${domain}`, before: describe(pending.record) }];
	});

	const advice = $derived.by((): string[] => {
		if (!pending) return [];
		if (pending.kind === 'delete') {
			return [
				'Validating resolvers stop expecting signatures once this DS record has expired from their caches. Turn off signing at the DNS provider only after that, not before.'
			];
		}
		const out = [
			'Only add a DS record that the DNS provider serving this zone gave you. If it does not match the key the zone is signed with, validating resolvers refuse every name in the domain.'
		];
		if (DS_DIGEST_TYPES[pending.value.digestType]?.retiring) {
			out.push(
				'Digest type 1 (SHA-1) is being retired by registries. Use digest type 2 if the provider offers it.'
			);
		}
		return out;
	});

	async function apply() {
		if (!pending) return;
		applying = true;
		applyError = null;
		const p = pending;
		const answer =
			p.kind === 'create'
				? await call<WriteResult>('POST', domainApi(domain, 'dnssec'), { ...p.value, confirm: domain })
				: await call<WriteResult>('DELETE', domainApi(domain, 'dnssec', p.record.keyTag), {
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
		if (!answer.data.ok) return void (applyError = answer.data.error);
		done = {
			text:
				p.kind === 'create'
					? `DS record ${p.value.keyTag} added at the registry. DNSSEC is on once resolvers see it, usually within hours.`
					: `DS record ${p.record.keyTag} deleted at the registry.`,
			warnings: answer.data.warnings
		};
		open = false;
		form = null;
		await onchanged();
	}
</script>

<section class="fp-section" aria-labelledby="dnssec-title">
	<div class="fp-section__head">
		<h2 class="t-title-2" id="dnssec-title">DNSSEC</h2>
		{#if part.value}<AsOf at={part.value.fetchedAt} {timeZone} stale={part.value.stale} />{/if}
	</div>
	<p class="fp-lede">
		The DS records at the registry. They tell resolvers which key signs this domain's DNS answers, so they
		must match the key of the provider that serves the zone.
	</p>

	{#if done}
		<Notice kind="success">{done.text}</Notice>
		<PorkbunNotice warnings={done.warnings} />
	{/if}

	{#if part.error}
		<PorkbunNotice error={part.error} />
	{:else if part.value}
		{#if records.length === 0}
			<EmptyState
				title="DNSSEC is off"
				line={atPorkbun === false
					? 'No DS record is published. If the provider serving this zone signs it, add the DS record it gives you here.'
					: 'No DS record is published for this domain.'}
			/>
		{:else}
			<div class="fp-panel fp-table__wrap scroller">
				<table class="fp-table">
					<caption class="visually-hidden">DS records of {domain}</caption>
					<thead>
						<tr>
							<th scope="col">Key tag</th>
							<th scope="col">Algorithm</th>
							<th scope="col">Digest</th>
							<th scope="col"><span class="visually-hidden">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each records as r (r.keyTag + r.digest)}
							<tr>
								<td class="t-mono">{r.keyTag}</td>
								<td class="nowrap">{r.alg} · {algorithmName(r.alg)}</td>
								<td class="digest">
									<span class="t-caption">{digestTypeName(r.digestType)}</span>
									<RecordValue content={r.digest} clip />
								</td>
								<td class="actions">
									<ScopeGate {status} scope="domains" showReason={false}>
										{#snippet children({ disabled })}
											<button
												class="fp-btn fp-btn--quiet danger"
												type="button"
												{disabled}
												onclick={() => reviewDelete(r)}>Delete…</button
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
				<h3 class="t-ui lbl">Add a DS record</h3>
				<div class="fld">
					<label class="t-ui" for="ds-paste">Paste the DS record from your DNS provider</label>
					<span class="fp-field">
						<input
							id="ds-paste"
							class="t-mono"
							bind:value={pasted}
							oninput={fromPaste}
							placeholder="{domain}. 3600 IN DS 2371 13 2 49FD46E6C4B45C55D4AC…"
							autocomplete="off"
							spellcheck="false"
						/>
					</span>
					<p class="t-caption">Fills the fields below. You can also type them.</p>
				</div>
				<div class="fields">
					<div class="fld">
						<label class="t-ui" for="ds-tag">Key tag</label>
						<span class="fp-field small" class:bad={fieldError('keyTag')}>
							<input
								id="ds-tag"
								class="t-mono"
								bind:value={form.keyTag}
								inputmode="numeric"
								autocomplete="off"
							/>
						</span>
						{#if fieldError('keyTag')}<p class="t-caption err">{fieldError('keyTag')}</p>{/if}
					</div>
					<div class="fld">
						<label class="t-ui" for="ds-alg">Algorithm</label>
						<span class="fp-select" class:bad={fieldError('alg')}>
							<select id="ds-alg" bind:value={form.alg}>
								{#if !usable.some(([n]) => n === form?.alg)}<option value={form.alg}
										>{form.alg} · {algorithmName(form.alg)}</option
									>{/if}
								{#each usable as [n, a] (n)}<option value={n}>{n} · {a.name}</option>{/each}
							</select>
							<ChevronDown class="fp-ico fp-ico--sm" aria-hidden="true" />
						</span>
						{#if fieldError('alg')}<p class="t-caption err">{fieldError('alg')}</p>{/if}
					</div>
					<div class="fld">
						<label class="t-ui" for="ds-dt">Digest type</label>
						<span class="fp-select" class:bad={fieldError('digestType')}>
							<select id="ds-dt" bind:value={form.digestType}>
								{#if !(form.digestType in DS_DIGEST_TYPES)}<option value={form.digestType}
										>{form.digestType}</option
									>{/if}
								{#each Object.entries(DS_DIGEST_TYPES) as [n, d] (n)}<option value={n}>{n} · {d.name}</option
									>{/each}
							</select>
							<ChevronDown class="fp-ico fp-ico--sm" aria-hidden="true" />
						</span>
					</div>
				</div>
				<div class="fld">
					<label class="t-ui" for="ds-digest">Digest</label>
					<textarea
						id="ds-digest"
						class="t-mono area"
						rows="2"
						bind:value={form.digest}
						spellcheck="false"
						aria-invalid={fieldError('digest') ? 'true' : undefined}
					></textarea>
					{#if fieldError('digest')}<p class="t-caption err">{fieldError('digest')}</p>{/if}
				</div>
				<details>
					<summary class="t-ui">Key data (only if your DNS provider gives it)</summary>
					<div class="fields keydata">
						<div class="fld">
							<label class="t-ui" for="kd-flags">Flags</label>
							<span class="fp-field small" class:bad={fieldError('keyDataFlags')}
								><input id="kd-flags" class="t-mono" bind:value={form.keyDataFlags} placeholder="257" /></span
							>
						</div>
						<div class="fld">
							<label class="t-ui" for="kd-proto">Protocol</label>
							<span class="fp-field small" class:bad={fieldError('keyDataProtocol')}
								><input
									id="kd-proto"
									class="t-mono"
									bind:value={form.keyDataProtocol}
									placeholder="3"
								/></span
							>
						</div>
						<div class="fld">
							<label class="t-ui" for="kd-algo">Algorithm</label>
							<span class="fp-field small" class:bad={fieldError('keyDataAlgo')}
								><input id="kd-algo" class="t-mono" bind:value={form.keyDataAlgo} placeholder="13" /></span
							>
						</div>
						<div class="fld">
							<label class="t-ui" for="kd-life">Max signature life (s)</label>
							<span class="fp-field small" class:bad={fieldError('maxSigLife')}
								><input id="kd-life" class="t-mono" bind:value={form.maxSigLife} /></span
							>
						</div>
						<div class="fld fld--wide">
							<label class="t-ui" for="kd-key">Public key (base64)</label>
							<textarea
								id="kd-key"
								class="t-mono area"
								rows="2"
								bind:value={form.keyDataPubKey}
								spellcheck="false"
								aria-invalid={fieldError('keyDataPubKey') ? 'true' : undefined}
							></textarea>
						</div>
					</div>
					{#if touched && checked && !checked.ok && Object.keys(checked.fields).some((k) => k.startsWith('keyData') || k === 'maxSigLife')}
						<p class="t-caption err">
							{Object.entries(checked.fields)
								.filter(([k]) => k.startsWith('keyData') || k === 'maxSigLife')
								.map(([, v]) => v)
								.join('. ')}
						</p>
					{/if}
				</details>
				<div class="btns">
					<button class="fp-btn" type="button" onclick={() => (form = null)}>Cancel</button>
					<button class="fp-btn fp-btn--primary" type="button" onclick={reviewAdd}>Review…</button>
				</div>
			</div>
		{:else}
			<p>
				<ScopeGate {status} scope="domains">
					{#snippet children({ disabled })}
						<button
							class="fp-btn"
							type="button"
							{disabled}
							onclick={() => {
								form = blank();
								pasted = '';
								touched = false;
								done = null;
							}}>Add DS record…</button
						>
					{/snippet}
				</ScopeGate>
			</p>
		{/if}
	{/if}
</section>

<ReviewDialog
	bind:open
	title={pending?.kind === 'delete' ? 'Delete DS record' : 'Turn on DNSSEC: add DS record'}
	intro={pending?.kind === 'delete'
		? 'Porkbun has no rehearsal for DNSSEC changes. Nothing is sent until you apply.'
		: 'Porkbun has no rehearsal for DNSSEC changes, so its safety check runs instead. Nothing is sent until you apply.'}
	{changes}
	warnings={advice}
	blocked={preflight && preflight.blockers.length > 0
		? "Porkbun's safety check found a blocker, listed above. Fix it first."
		: null}
	confirmText={domain}
	confirmPurpose={pending?.kind === 'delete' ? 'to delete the DS record' : 'to add the DS record'}
	destructive={pending?.kind === 'delete'}
	applyLabel={pending?.kind === 'delete' ? 'Delete' : 'Add DS record'}
	busy={applying || checking}
	error={applyError}
	onapply={apply}
	oncancel={() => (seq += 1)}
>
	{#if checking}
		<p class="t-ui t-muted" role="status">Running Porkbun's safety check…</p>
	{:else if checkError}
		<PorkbunNotice error={checkError} />
	{:else if preflight && preflight.checks.some((c) => !c.ok)}
		<PreflightChecks {preflight} onlyFailing summary={false} />
	{/if}
</ReviewDialog>

<style>
	/* Holds the visually hidden labels of the last column, so they do not widen the page on a phone. */
	.scroller {
		position: relative;
	}
	td {
		vertical-align: top;
	}
	.nowrap {
		white-space: nowrap;
	}
	.digest {
		display: flex;
		flex-direction: column;
		max-width: 360px;
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
	.keydata {
		margin-top: var(--space-3);
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
	}
	.small {
		width: 9ch;
		min-width: 90px;
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
		overflow-wrap: anywhere;
	}
	.area[aria-invalid='true'] {
		border-color: var(--error-ink);
	}
	summary {
		cursor: pointer;
	}
	.btns {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
