<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import type { DnsRecord, DnsRecordInput, DnsRecordType } from '$lib/api/porkbun';
	import { Notice } from '$lib/design/components';
	import { RecordValue } from '$lib/porkbun/components';
	import { KIND_ORDER, RECORD_KINDS, type FieldDef, type Parts } from '$lib/porkbun/records/kinds';
	import { fqdn } from '$lib/porkbun/records/names';
	import { conflictsWith } from '$lib/porkbun/records/plan';
	import type { FieldError, RecordSnapshot } from '$lib/porkbun/records/types';
	import {
		formatOf,
		snapshotOf,
		validateParts,
		validateRecord,
		type Validated
	} from '$lib/porkbun/records/validate';
	import { ttlLabel } from '$lib/porkbun/records/view';

	/**
	 * The form for one record: the fields of its type, checked as they are typed with the same rules the
	 * server uses. Saving puts the record into the pending changes; nothing is sent from here.
	 */
	type Props = {
		domain: string;
		/** The live record being changed, or null for a record to add. */
		live: DnsRecord | null;
		/** What to start from: a pending change to pick up again, or a record to copy. */
		start: DnsRecordInput | null;
		/** Every other record as the zone will be, to notice a clash before the review does. */
		others: readonly RecordSnapshot[];
		saveLabel: string;
		onsave: (record: DnsRecordInput) => void;
		oncancel: () => void;
	};
	let { domain, live, start, others, saveLabel, onsave, oncancel }: Props = $props();

	const stored = $derived(live ? snapshotOf(live) : undefined);

	// The form is created anew every time the dialog opens, so its fields start from the props once.
	const first = () => {
		const from = start ?? (live ? { ...snapshotOf(live), type: live.type as DnsRecordType } : null);
		const type = (from?.type ?? 'A') as DnsRecordType;
		const kind = RECORD_KINDS[type];
		const parts = from ? kind.split(from.content, from.prio ?? null) : { ...kind.defaults };
		return {
			type,
			host: from?.host ?? '',
			parts: parts ?? { ...kind.defaults },
			raw: parts === null,
			rawContent: from?.content ?? '',
			rawPrio: String(from?.prio ?? 0),
			ttl: String(from?.ttl ?? 600),
			notes: from?.notes ?? ''
		};
	};
	const init = first();
	let type = $state<DnsRecordType>(init.type);
	let host = $state(init.host);
	let parts = $state<Parts>(init.parts);
	let raw = $state(init.raw);
	let rawContent = $state(init.rawContent);
	let rawPrio = $state(init.rawPrio);
	let ttl = $state(init.ttl);
	let notes = $state(init.notes);
	let tried = $state(false);

	const kind = $derived(RECORD_KINDS[type]);
	const name = $derived(fqdn(host.trim().toLowerCase().replace(/^@$/, ''), domain));

	function changeType(next: string) {
		type = next as DnsRecordType;
		parts = { ...RECORD_KINDS[type].defaults };
		raw = false;
		tried = false;
	}

	const checked: Validated = $derived(
		raw
			? validateRecord(
					{ host, type, content: rawContent, ...(kind.usesPrio ? { prio: rawPrio } : {}), ttl, notes },
					domain,
					{ stored }
				)
			: validateParts({ host, type, parts, ttl, notes }, domain)
	);
	const errors: FieldError[] = $derived(checked.ok ? [] : checked.errors);
	const shown = $derived(tried ? errors : []);
	const errorFor = (field: string, part?: string) =>
		shown.find((e) => e.field === field && (part === undefined || e.part === part))?.message;
	const partError = (key: string) =>
		shown.find((e) => e.part === key && (e.field === 'content' || e.field === 'prio'))?.message;
	const looseContent = $derived(shown.find((e) => e.field === 'content' && e.part === undefined)?.message);

	/** The record as it would be stored, once it is valid. */
	const after: RecordSnapshot | null = $derived(
		checked.ok
			? {
					host: checked.record.host,
					type: checked.record.type,
					content: checked.record.content,
					ttl: checked.record.ttl ?? stored?.ttl ?? 600,
					prio: checked.record.prio ?? null,
					notes: checked.record.notes ?? null
				}
			: null
	);
	// As the server does: a record that only gets a new TTL or note is not held against its neighbours.
	const moved = $derived(!stored || !after || stored.host !== after.host || stored.content !== after.content);
	const clashes = $derived(after && moved ? conflictsWith(others, after, fqdn(after.host, domain)) : []);

	const ttlNumber = $derived(/^\d+$/.test(ttl.trim()) ? Number(ttl.trim()) : null);

	function optionsOf(def: FieldDef) {
		const options = def.options ?? [];
		const current = parts[def.key] ?? '';
		return current === '' || options.some((o) => o.value === current)
			? options
			: [...options, { value: current, label: current }];
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		if (!checked.ok || clashes.length > 0) return;
		onsave(checked.record);
	}
</script>

<form class="form" novalidate onsubmit={submit}>
	<div class="lbl">
		<label class="t-ui" for="rf-type">Type</label>
		<span class="fp-select">
			<select
				id="rf-type"
				value={type}
				disabled={live !== null}
				onchange={(e) => changeType(e.currentTarget.value)}
				aria-describedby="rf-type-help"
			>
				{#each KIND_ORDER as t (t)}
					<option value={t}>{t} · {RECORD_KINDS[t].title}</option>
				{/each}
			</select>
			<ChevronDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
		</span>
		<span class="t-caption" id="rf-type-help">
			{kind.summary}
			{#if live}The type of a record can not be changed: delete it and add another instead.{/if}
		</span>
	</div>

	<div class="lbl">
		<label class="t-ui" for="rf-host">Name</label>
		<span class="fp-field host" class:bad={errorFor('host')}>
			<input
				id="rf-host"
				class="t-mono"
				bind:value={host}
				placeholder="@"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				aria-invalid={errorFor('host') ? 'true' : undefined}
				aria-describedby="rf-host-help"
			/>
			<span class="t-mono suffix" aria-hidden="true">.{domain}</span>
		</span>
		<span class="t-caption" class:bad={errorFor('host')} id="rf-host-help">
			{#if errorFor('host')}{errorFor('host')}{:else}The part before .{domain}. Leave it empty or type @ for
				{domain} itself; * is a wildcard. {kind.hostHint ?? ''}{/if}
		</span>
	</div>

	{#if raw}
		<Notice>
			This value is not in the form this page writes for {type} records ({formatOf(kind)}), so it is shown as
			it is stored. The name, TTL and notes can be changed as usual.
		</Notice>
		{#if kind.usesPrio}
			<div class="lbl">
				<label class="t-ui" for="rf-raw-prio">Priority</label>
				<span class="fp-field" class:bad={errorFor('prio')}
					><input
						id="rf-raw-prio"
						class="t-mono"
						inputmode="numeric"
						bind:value={rawPrio}
						autocomplete="off"
						aria-invalid={errorFor('prio') ? 'true' : undefined}
						aria-describedby={errorFor('prio') ? 'rf-raw-prio-help' : undefined}
					/></span
				>
				{#if errorFor('prio')}<span class="t-caption bad" id="rf-raw-prio-help">{errorFor('prio')}</span>{/if}
			</div>
		{/if}
		<div class="lbl">
			<label class="t-ui" for="rf-raw">Value</label>
			<textarea
				id="rf-raw"
				class="area t-mono"
				rows="3"
				spellcheck="false"
				bind:value={rawContent}
				aria-invalid={errorFor('content') ? 'true' : undefined}
				aria-describedby={errorFor('content') ? 'rf-raw-help' : undefined}
			></textarea>
			{#if errorFor('content')}<span class="t-caption bad" id="rf-raw-help">{errorFor('content')}</span>{/if}
		</div>
	{:else}
		<div class="fields">
			{#each kind.fields as def (type + def.key)}
				{@const bad = partError(def.key)}
				{@const id = `rf-part-${def.key}`}
				{@const help = bad ?? def.hint}
				<div class="lbl" class:small={def.kind === 'number' || def.kind === 'select'}>
					<label class="t-ui" for={id}>{def.label}</label>
					{#if def.kind === 'select'}
						<span class="fp-select" class:bad>
							<select
								{id}
								bind:value={parts[def.key]}
								aria-invalid={bad ? 'true' : undefined}
								aria-describedby={help ? `${id}-help` : undefined}
							>
								{#each optionsOf(def) as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
							</select>
							<ChevronDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
						</span>
					{:else if def.kind === 'long'}
						<textarea
							{id}
							class="area t-mono"
							rows="3"
							spellcheck="false"
							placeholder={def.placeholder}
							bind:value={parts[def.key]}
							aria-invalid={bad ? 'true' : undefined}
							aria-describedby={help ? `${id}-help` : undefined}
						></textarea>
					{:else}
						<span class="fp-field" class:bad>
							<input
								{id}
								class="t-mono"
								inputmode={def.kind === 'number' ? 'numeric' : undefined}
								placeholder={def.placeholder}
								autocomplete="off"
								autocapitalize="off"
								spellcheck="false"
								bind:value={parts[def.key]}
								aria-invalid={bad ? 'true' : undefined}
								aria-describedby={help ? `${id}-help` : undefined}
							/>
						</span>
					{/if}
					{#if help}<span class="t-caption" class:bad id="{id}-help">{help}</span>{/if}
				</div>
			{/each}
		</div>
		{#if looseContent}<p class="t-caption bad" role="alert">{looseContent}</p>{/if}
	{/if}

	<div class="fields">
		<div class="lbl small">
			<label class="t-ui" for="rf-ttl">TTL</label>
			<span class="fp-field" class:bad={errorFor('ttl')}>
				<input
					id="rf-ttl"
					class="t-mono"
					inputmode="numeric"
					list="rf-ttls"
					bind:value={ttl}
					autocomplete="off"
					aria-invalid={errorFor('ttl') ? 'true' : undefined}
					aria-describedby="rf-ttl-help"
				/>
			</span>
			<datalist id="rf-ttls">
				{#each [600, 1800, 3600, 14400, 86400] as s (s)}<option value={s}>{ttlLabel(s)}</option>{/each}
			</datalist>
			<span class="t-caption" class:bad={errorFor('ttl')} id="rf-ttl-help">
				{#if errorFor('ttl')}{errorFor('ttl')}{:else}Seconds{ttlNumber ? ` (${ttlLabel(ttlNumber)})` : ''}.
					Porkbun's minimum is usually 600.{/if}
			</span>
		</div>
		<div class="lbl wide">
			<label class="t-ui" for="rf-notes">Notes <span class="t-muted">(optional)</span></label>
			<span class="fp-field" class:bad={errorFor('notes')}>
				<input
					id="rf-notes"
					bind:value={notes}
					autocomplete="off"
					maxlength="1000"
					aria-invalid={errorFor('notes') ? 'true' : undefined}
					aria-describedby="rf-notes-help"
				/>
			</span>
			<span class="t-caption" class:bad={errorFor('notes')} id="rf-notes-help">
				{#if errorFor('notes')}{errorFor('notes')}{:else}Kept with the record at Porkbun. Not part of DNS.{/if}
			</span>
		</div>
	</div>

	{#if after}
		<p class="stored">
			<span class="t-caption">Stored as</span>
			<span class="t-mono stored__name">{after.type} {name}</span>
			<RecordValue type={after.type} content={after.content} prio={after.prio} />
		</p>
	{/if}
	{#each clashes as clash, i (i)}
		<Notice kind="error">
			<p>{clash.message}.</p>
			{#if clash.code === 'CNAME_CONFLICT'}
				<p>To replace a record, delete it here first: both changes then go out in one batch.</p>
			{/if}
		</Notice>
	{/each}
	{#if checked.ok}
		{#each checked.advice as line, i (i)}<Notice>{line}</Notice>{/each}
	{/if}

	<div class="foot">
		<button class="fp-btn" type="button" onclick={oncancel}>Cancel</button>
		<button
			class="fp-btn fp-btn--primary"
			type="submit"
			disabled={tried && (!checked.ok || clashes.length > 0)}>{saveLabel}</button
		>
	</div>
</form>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.lbl {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.lbl :global(.fp-field),
	.lbl :global(.fp-select),
	.lbl :global(.fp-select select) {
		width: 100%;
	}
	.bad {
		color: var(--error-ink);
	}
	.fp-field.bad,
	.fp-select.bad,
	.area[aria-invalid='true'] {
		border-color: var(--error);
		color: var(--text);
	}
	.host input {
		text-align: right;
	}
	.suffix {
		color: var(--muted);
		font-size: 13px;
		white-space: nowrap;
		max-width: 55%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: var(--space-4) var(--space-3);
	}
	.fields .lbl {
		grid-column: span 6;
	}
	.fields .lbl.small {
		grid-column: span 2;
	}
	.fields .lbl.wide {
		grid-column: span 4;
	}
	@media (max-width: 520px) {
		.fields .lbl.small {
			grid-column: span 3;
		}
		.fields .lbl.wide {
			grid-column: span 6;
		}
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
	.area:hover {
		border-color: var(--faint);
	}
	.area:focus-visible {
		outline: 0;
		border-color: var(--acc-ink);
		box-shadow: var(--focus-ring);
	}
	.stored {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-3);
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-lg);
		background: var(--sunk);
		overflow-wrap: anywhere;
	}
	.stored__name {
		font-size: 13px;
		line-height: 20px;
		color: var(--muted);
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
