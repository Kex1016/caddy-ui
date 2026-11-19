<script lang="ts">
	import type { ApiError, DryRun, PorkbunStatus } from '$lib/api/porkbun';
	import { Notice } from '$lib/design/components';
	import { PorkbunNotice, RecordValue, ReviewDialog, ScopeGate } from '$lib/porkbun/components';
	import { IMPORT_LIMIT } from '$lib/porkbun/records/import';
	import { fqdn } from '$lib/porkbun/records/names';
	import { statusText } from '$lib/porkbun/records/review';
	import type { ImportEntry, ImportReview, ImportVerdict } from '$lib/porkbun/records/types';
	import { call, domainApi } from '$lib/porkbun/registry/api';
	import { domainHref } from '$lib/porkbun/tabs';
	import type { ReviewChange } from '$lib/porkbun/types';

	/**
	 * Import records from a zone file, from the JSON this page exports, or from a scan of the domain's live
	 * DNS. Three steps: read the source and sort every record against the zone (nothing is sent), review the
	 * records that are new with Porkbun's rehearsal, import.
	 */
	type Props = {
		domain: string;
		status: PorkbunStatus;
		/** Called after an import changed the zone. */
		onchanged: () => Promise<void>;
		onclose: () => void;
	};
	let { domain, status, onchanged, onclose }: Props = $props();

	let source = $state<'text' | 'scan'>('text');
	let text = $state('');
	let fileNote = $state<string | null>(null);

	let checking = $state(false);
	let checkError = $state<ApiError | null>(null);
	let found = $state<ImportReview | null>(null);
	/** Position in `found.entries` of each new record still ticked. */
	let picked = $state<Record<number, boolean>>({});
	let show = $state<ImportVerdict | 'all'>('all');
	let seq = 0;

	const LABEL: Record<ImportVerdict, string> = {
		new: 'new',
		existing: 'already there',
		conflict: 'in conflict',
		ignored: 'left out',
		invalid: 'not valid'
	};
	const KIND: Record<ImportVerdict, string> = {
		new: 'fp-tag--acc',
		existing: '',
		conflict: 'fp-tag--error',
		ignored: '',
		invalid: 'fp-tag--error'
	};
	const VERDICTS: ImportVerdict[] = ['new', 'existing', 'conflict', 'ignored', 'invalid'];

	async function readFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (file.size > 1024 * 1024) {
			fileNote = `${file.name} is larger than 1 MB, which is more than an import takes.`;
			return;
		}
		text = await file.text();
		fileNote = `Read ${file.name}.`;
		found = null;
	}

	async function check() {
		const mine = ++seq;
		checking = true;
		checkError = null;
		found = null;
		done = null;
		const body = source === 'scan' ? { scan: true, dryRun: true } : { text, dryRun: true };
		const answer = await call<ImportReview>('POST', domainApi(domain, 'dns', 'import'), body);
		if (mine !== seq) return;
		checking = false;
		if (!answer.ok) {
			checkError = answer.error;
			return;
		}
		found = answer.data;
		show = 'all';
		picked = Object.fromEntries(
			answer.data.entries.flatMap((e, i) => (e.verdict === 'new' ? [[i, true]] : []))
		);
	}

	const entries = $derived(found?.entries ?? []);
	const chosen = $derived(entries.filter((e, i) => e.verdict === 'new' && picked[i]));
	const listed = $derived(
		entries.map((entry, i) => ({ entry, i })).filter(({ entry }) => show === 'all' || entry.verdict === show)
	);
	const newCount = $derived(entries.filter((e) => e.verdict === 'new').length);
	const allPicked = $derived(newCount > 0 && chosen.length === newCount);

	function pickAll(on: boolean) {
		picked = Object.fromEntries(entries.flatMap((e, i) => (e.verdict === 'new' ? [[i, on]] : [])));
	}

	const asRecord = (e: ImportEntry) => ({
		host: e.host,
		type: e.type,
		content: e.content,
		...(e.ttl !== undefined ? { ttl: e.ttl } : {}),
		...(e.prio !== undefined ? { prio: e.prio } : {})
	});
	const valueOf = (e: ImportEntry) =>
		`${e.prio !== undefined && (e.type === 'MX' || e.type === 'SRV') ? `${e.prio} ` : ''}${e.content} · TTL ${e.ttl ?? 600}`;

	// ── Review and import ────────────────────────────────────────────────────────────────────────────────
	let open = $state(false);
	let rehearsal = $state<DryRun | 'running' | null>(null);
	let applying = $state(false);
	let applyError = $state<ApiError | null>(null);
	let done = $state<ImportReview | null>(null);

	const changes: ReviewChange[] = $derived(
		chosen.map((e) => ({
			kind: 'create',
			title: `${e.type} ${fqdn(e.host, domain)}`,
			after: valueOf(e),
			...(e.notes
				? { note: `The note "${e.notes}" is not imported: Porkbun's import does not take notes.` }
				: {})
		}))
	);

	function asDryRun(review: ImportReview): DryRun {
		const refused = review.entries.filter((e) => e.verdict === 'conflict' || e.verdict === 'invalid').length;
		const failed = (review.porkbun?.failed ?? 0) + refused;
		const error: ApiError | undefined =
			review.error ??
			(failed > 0
				? {
						code: 'IMPORT_WOULD_FAIL',
						message: `Porkbun would not take ${failed} of these records. Check the import again to see which.`,
						retryable: false
					}
				: undefined);
		return {
			wouldSucceed: review.ok && failed === 0,
			warnings: review.warnings,
			...(error ? { error } : {})
		};
	}

	async function review() {
		const mine = ++seq;
		applyError = null;
		rehearsal = 'running';
		open = true;
		const answer = await call<ImportReview>('POST', domainApi(domain, 'dns', 'import'), {
			records: chosen.map(asRecord),
			dryRun: true
		});
		if (mine !== seq) return;
		rehearsal = answer.ok
			? asDryRun(answer.data)
			: { wouldSucceed: false, warnings: [], error: answer.error };
	}

	async function apply() {
		applying = true;
		applyError = null;
		const answer = await call<ImportReview>('POST', domainApi(domain, 'dns', 'import'), {
			records: chosen.map(asRecord)
		});
		applying = false;
		if (!answer.ok) {
			applyError = answer.error;
			return;
		}
		done = answer.data;
		open = false;
		found = null;
		text = '';
		fileNote = null;
		await onchanged();
	}

	const failureLine = (f: unknown): string => {
		if (f && typeof f === 'object') {
			const o = f as Record<string, unknown>;
			const what = [o.type, o.name ?? o.host].filter((v) => typeof v === 'string' && v !== '').join(' ');
			const why = typeof o.reason === 'string' ? o.reason : typeof o.message === 'string' ? o.message : '';
			if (what || why) return [what, why].filter(Boolean).join(': ');
		}
		return typeof f === 'string' ? f : JSON.stringify(f);
	};
	const imported = $derived(
		done ? (done.porkbun?.created ?? 0) + done.delegations.filter((d) => d.status === 'applied').length : 0
	);
</script>

<section class="fp-panel imp" aria-labelledby="imp-title">
	<div class="imp__head">
		<h3 class="t-title-2" id="imp-title">Import records</h3>
		<button class="fp-btn fp-btn--quiet" type="button" onclick={onclose}>Close</button>
	</div>

	{#if done}
		<Notice kind={done.ok ? 'success' : 'warning'}>
			<p>
				<b>{imported} record{imported === 1 ? '' : 's'} imported.</b>
				{#if done.porkbun && done.porkbun.skipped > 0}{done.porkbun.skipped} already there and left as they are.{/if}
				{#if done.porkbun && done.porkbun.failed > 0}{done.porkbun.failed} could not be imported.{/if}
				{#if done.porkbun && done.porkbun.created > 0}
					Porkbun took a restore point of the zone first; it is on the
					<a href={domainHref(domain, 'history')}>History tab</a>.
				{/if}
			</p>
			{#if done.porkbun && done.porkbun.failures.length > 0}
				<ul class="fails">
					{#each done.porkbun.failures as f, i (i)}<li class="t-mono">{failureLine(f)}</li>{/each}
				</ul>
			{/if}
			{#each done.delegations.filter((d) => d.status !== 'applied') as d (d.index)}
				<p>
					<span class="t-mono">{d.type} {d.name}</span>: {statusText(d.status)}{d.error
						? `. ${d.error.message}`
						: ''}
				</p>
			{/each}
		</Notice>
		{#if done.error}<PorkbunNotice error={done.error} />{/if}
		<PorkbunNotice warnings={done.warnings} />
	{/if}

	<div class="fp-seg" role="group" aria-label="Where the records come from">
		<button type="button" aria-pressed={source === 'text'} onclick={() => ((source = 'text'), (found = null))}
			>A zone file or JSON</button
		>
		<button type="button" aria-pressed={source === 'scan'} onclick={() => ((source = 'scan'), (found = null))}
			>What the domain answers now</button
		>
	</div>

	{#if source === 'text'}
		<div class="lbl">
			<label class="t-ui" for="imp-text">Zone file (BIND format) or the JSON this page exports</label>
			<textarea
				id="imp-text"
				class="area t-mono"
				rows="7"
				spellcheck="false"
				placeholder={`www   3600 IN A     203.0.113.10\n@     3600 IN MX    10 mail.${domain}.`}
				bind:value={text}
				oninput={() => (found = null)}
				aria-describedby="imp-text-help"
			></textarea>
		</div>
		<p class="pick">
			<label class="fp-btn file">
				Choose a file…
				<input type="file" accept=".zone,.txt,.json,.db,text/plain,application/json" onchange={readFile} />
			</label>
			{#if fileNote}<span class="t-caption" role="status">{fileNote}</span>{/if}
		</p>
		<p class="t-caption" id="imp-text-help">
			SOA records and the domain's own NS records are left out, records already in the zone are skipped, and
			notes are not imported. At most {IMPORT_LIMIT} new records at a time.
		</p>
	{:else}
		<p class="t-ui t-muted">
			Porkbun asks the domain's current nameservers for the names it knows to look for (the domain itself,
			common subdomains, mail and verification records) and lists what they answer. It is thorough, not
			complete: DNS has no way to list a zone. Use it before moving a domain's nameservers to Porkbun. Porkbun
			allows 20 scans an hour.
		</p>
	{/if}

	<div class="btns">
		<ScopeGate {status} scope="dns">
			{#snippet children({ disabled })}
				<button
					class="fp-btn"
					type="button"
					disabled={disabled || checking || (source === 'text' && text.trim() === '')}
					onclick={check}
					>{checking
						? source === 'scan'
							? 'Scanning…'
							: 'Checking…'
						: source === 'scan'
							? 'Scan'
							: 'Check against the zone'}</button
				>
			{/snippet}
		</ScopeGate>
		<span class="t-caption">Checking sends nothing that changes the zone.</span>
	</div>

	{#if checkError}<PorkbunNotice error={checkError} />{/if}

	{#if found}
		{#if found.entries.length === 0 && found.unreadable.length === 0}
			<Notice
				>{found.source === 'scan'
					? 'The scan found no records.'
					: 'There are no records in this text.'}</Notice
			>
		{:else}
			<div class="fp-chips" role="group" aria-label="Show">
				<button class="fp-chip" type="button" aria-pressed={show === 'all'} onclick={() => (show = 'all')}
					>All <span class="n">{found.entries.length}</span></button
				>
				{#each VERDICTS.filter((v) => (found?.counts[v] ?? 0) > 0) as v (v)}
					<button class="fp-chip" type="button" aria-pressed={show === v} onclick={() => (show = v)}
						>{LABEL[v]} <span class="n">{found.counts[v]}</span></button
					>
				{/each}
			</div>
			{#if found.unreadable.length > 0}
				<Notice kind="warning">
					<p>
						<b>{found.unreadable.length} line{found.unreadable.length === 1 ? '' : 's'} could not be read</b>
						and
						{found.unreadable.length === 1 ? 'is' : 'are'} not part of the import.
					</p>
					<ul class="fails">
						{#each found.unreadable.slice(0, 20) as u (u.line)}<li>Line {u.line}: {u.message}</li>{/each}
						{#if found.unreadable.length > 20}<li>…and {found.unreadable.length - 20} more.</li>{/if}
					</ul>
				</Notice>
			{/if}
			{#if found.error}<PorkbunNotice error={found.error} />{/if}
			<PorkbunNotice warnings={found.warnings} />
			<div class="fp-table__wrap scroller">
				<table class="fp-table">
					<caption class="visually-hidden">Records read from the source</caption>
					<thead>
						<tr>
							<th scope="col" class="tick">
								<input
									type="checkbox"
									aria-label="Import every new record"
									checked={allPicked}
									disabled={newCount === 0}
									onchange={(e) => pickAll(e.currentTarget.checked)}
								/>
							</th>
							<th scope="col">Record</th>
							<th scope="col">Value</th>
							<th scope="col">Verdict</th>
						</tr>
					</thead>
					<tbody>
						{#each listed as { entry, i } (i)}
							<tr>
								<td class="tick">
									{#if entry.verdict === 'new'}
										<input
											type="checkbox"
											aria-label="Import {entry.type} {fqdn(entry.host, domain)}"
											bind:checked={picked[i]}
										/>
									{/if}
								</td>
								<td class="t-mono rec"><b>{entry.type}</b> {fqdn(entry.host, domain)}</td>
								<td class="val">
									<RecordValue type={entry.type} content={entry.content} prio={entry.prio ?? null} />
								</td>
								<td>
									<span class="fp-tag {KIND[entry.verdict]}">{LABEL[entry.verdict]}</span>
									{#if entry.reason}<span class="t-caption why">{entry.reason}</span>{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="btns">
				<button class="fp-btn fp-btn--primary" type="button" disabled={chosen.length === 0} onclick={review}
					>Review import of {chosen.length} record{chosen.length === 1 ? '' : 's'}…</button
				>
				{#if newCount === 0}<span class="t-caption">Nothing here is new to the zone.</span>{/if}
			</div>
		{/if}
	{/if}
</section>

<ReviewDialog
	bind:open
	title="Import {chosen.length} record{chosen.length === 1 ? '' : 's'}"
	intro="These records are created in {domain}. Porkbun rehearses the import first, and takes a restore point of the zone before it imports. Nothing is sent until you apply."
	{changes}
	dryRun={rehearsal}
	applyLabel="Import"
	busy={applying}
	error={applyError}
	onapply={apply}
	oncancel={() => (seq += 1)}
/>

<style>
	.imp {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.imp__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.fp-seg {
		align-self: flex-start;
		max-width: 100%;
		overflow-x: auto;
	}
	.lbl {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
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
		white-space: pre;
		overflow-x: auto;
	}
	.area:hover {
		border-color: var(--faint);
	}
	.area:focus-visible {
		outline: 0;
		border-color: var(--acc-ink);
		box-shadow: var(--focus-ring);
	}
	.pick,
	.btns {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}
	.file {
		position: relative;
		overflow: hidden;
	}
	.file input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.file:focus-within {
		box-shadow: var(--focus-ring);
	}
	.n {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--faint);
	}
	.scroller {
		position: relative;
		max-height: 50vh;
		overflow: auto;
	}
	.tick {
		width: 32px;
	}
	td {
		vertical-align: top;
	}
	.rec {
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	.val {
		max-width: 420px;
	}
	.why {
		display: block;
		margin-top: 2px;
		max-width: 360px;
	}
	.fails {
		margin: var(--space-1) 0 0 var(--space-5);
		overflow-wrap: anywhere;
	}
</style>
