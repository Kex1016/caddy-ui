<script lang="ts">
	import { Pencil, Undo2 } from '@lucide/svelte';
	import type { DnsRecord } from '$lib/api/porkbun';
	import { fqdn } from '$lib/porkbun/records/names';
	import { summarise } from '$lib/porkbun/records/plan';
	import type { Pending } from '$lib/porkbun/records/tray';

	/**
	 * The pending changes: what has been decided but not sent. It stays at the bottom of the window while the
	 * table scrolls, lists every change with a way to take it back, and leads to the review.
	 */
	type Props = {
		domain: string;
		/** In the order the changes will be sent. */
		tray: readonly Pending[];
		records: readonly DnsRecord[];
		disabled: boolean;
		reason: string | null;
		onreview: () => void;
		onedit: (pending: Pending) => void;
		onremove: (key: string) => void;
		onclear: () => void;
	};
	let { domain, tray, records, disabled, reason, onreview, onedit, onremove, onclear }: Props = $props();

	let expanded = $state(false);

	const VERB = { create: 'Add', edit: 'Change', delete: 'Delete' } as const;
	const count = (op: Pending['change']['op']) => tray.filter((p) => p.change.op === op).length;
	const summary = $derived(
		[
			[count('create'), 'to add'],
			[count('edit'), 'to change'],
			[count('delete'), 'to delete']
		]
			.filter(([n]) => (n as number) > 0)
			.map(([n, what]) => `${n} ${what}`)
			.join(', ')
	);

	type Line = { key: string; op: Pending['change']['op']; title: string; detail: string; gone: boolean };
	const lines: Line[] = $derived(
		tray.map((p) => {
			const c = p.change;
			if (c.op === 'create') {
				return {
					key: p.key,
					op: c.op,
					title: `${c.record.type} ${fqdn(c.record.host, domain)}`,
					detail: summarise({
						host: c.record.host,
						type: c.record.type,
						content: c.record.content,
						ttl: c.record.ttl ?? 600,
						prio: c.record.prio ?? null,
						notes: c.record.notes ?? null
					}),
					gone: false
				};
			}
			const live = records.find((r) => r.id === c.id);
			const was = live ?? (c.expect ? { ...c.expect, name: fqdn(c.expect.host, domain) } : null);
			const title = was ? `${was.type} ${was.name}` : `Record ${c.id}`;
			if (c.op === 'delete') {
				return { key: p.key, op: c.op, title, detail: was ? summarise(was) : '', gone: !live };
			}
			return {
				key: p.key,
				op: c.op,
				title,
				detail: summarise({
					host: c.record.host,
					type: c.record.type,
					content: c.record.content,
					ttl: c.record.ttl ?? was?.ttl ?? 600,
					prio: c.record.prio ?? was?.prio ?? null,
					notes: c.record.notes ?? was?.notes ?? null
				}),
				gone: !live
			};
		})
	);
</script>

<aside class="tray fp-panel" aria-label="Pending changes">
	<div class="tray__bar">
		<p class="tray__sum">
			<b>{tray.length} pending change{tray.length === 1 ? '' : 's'}</b>
			<span class="t-ui t-muted">{summary}. Nothing has been sent to Porkbun yet.</span>
		</p>
		<div class="tray__acts">
			<button
				class="fp-btn fp-btn--quiet"
				type="button"
				aria-expanded={expanded}
				aria-controls="tray-list"
				onclick={() => (expanded = !expanded)}>{expanded ? 'Hide' : 'Show'}</button
			>
			<button class="fp-btn" type="button" onclick={onclear}>Discard all</button>
			<button class="fp-btn fp-btn--primary" type="button" {disabled} onclick={onreview}
				>Review and apply…</button
			>
		</div>
	</div>
	{#if reason}<p class="t-caption">{reason}</p>{/if}
	{#if expanded}
		<ol class="tray__list" id="tray-list">
			{#each lines as line (line.key)}
				<li class="tray__item">
					<span
						class="fp-tag"
						class:fp-tag--error={line.op === 'delete'}
						class:fp-tag--acc={line.op !== 'delete'}>{VERB[line.op]}</span
					>
					<span class="tray__what">
						<span class="t-mono">{line.title}</span>
						<span class="t-mono t-muted" class:struck={line.op === 'delete'}>{line.detail}</span>
						{#if line.gone}
							<span class="t-caption gone">This record is no longer in the zone.</span>
						{/if}
					</span>
					<span class="tray__btns">
						{#if line.op !== 'delete' && !line.gone}
							<button
								class="fp-ibtn"
								type="button"
								aria-label="Edit the pending change to {line.title}"
								title="Edit"
								onclick={() => {
									const p = tray.find((t) => t.key === line.key);
									if (p) onedit(p);
								}}><Pencil class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /></button
							>
						{/if}
						<button
							class="fp-ibtn"
							type="button"
							aria-label="Take back the pending change to {line.title}"
							title="Take back"
							onclick={() => onremove(line.key)}
							><Undo2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /></button
						>
					</span>
				</li>
			{/each}
		</ol>
	{/if}
</aside>

<style>
	.tray {
		position: sticky;
		bottom: var(--space-4);
		z-index: 2;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		border-color: var(--acc-ink);
		box-shadow: var(--shadow-modal);
	}
	.tray__bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.tray__sum {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.tray__acts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.tray__list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 36vh;
		overflow-y: auto;
	}
	.tray__item {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-lg);
		background: var(--sunk);
	}
	.tray__what {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		font-size: 13px;
		line-height: 20px;
		overflow-wrap: anywhere;
	}
	.tray__btns {
		display: flex;
		gap: var(--space-1);
	}
	.struck {
		text-decoration: line-through;
	}
	.gone {
		color: var(--warning-ink);
	}
</style>
