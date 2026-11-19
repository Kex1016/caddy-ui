<script lang="ts">
	import { deserialize } from '$app/forms';
	import { Notice, Tag } from '$lib/design/components';
	import { formatDateTime, formatMs } from '$lib/format';
	import type { DiagnosticState, DiagnosticsReport } from '../types';

	/**
	 * "Check everything" (docs/settings-and-perf-plan.md §3, Diagnostics): runs the page's `?/diagnose` action and
	 * lists every check with its state, the details where there are some, and a link to where it is fixed.
	 */
	type Props = { timeZone: string };
	let { timeZone }: Props = $props();

	let report = $state<DiagnosticsReport | null>(null);
	let busy = $state(false);
	let failed = $state<string | null>(null);
	let copied = $state(false);

	const TAG: Record<DiagnosticState, 'success' | 'warning' | 'error' | 'neutral'> = {
		ok: 'success',
		warning: 'warning',
		error: 'error',
		off: 'neutral'
	};
	const WORD: Record<DiagnosticState, string> = { ok: 'OK', warning: 'Check', error: 'Problem', off: 'Off' };

	async function run() {
		busy = true;
		failed = null;
		copied = false;
		try {
			const res = await fetch('?/diagnose', {
				method: 'POST',
				body: new FormData(),
				headers: { 'x-sveltekit-action': 'true' }
			});
			const result = deserialize(await res.text());
			if (result.type === 'success' && result.data?.report) report = result.data.report as DiagnosticsReport;
			else failed = 'The checks did not run. Reload the page and try again.';
		} catch {
			failed = 'This UI could not be reached.';
		}
		busy = false;
	}

	const summary = $derived.by(() => {
		if (!report) return null;
		const n = (s: DiagnosticState) => report!.checks.filter((c) => c.state === s).length;
		return { error: n('error'), warning: n('warning') };
	});

	function asText(r: DiagnosticsReport): string {
		const lines = [`Caddy UI diagnostics, ${new Date(r.at).toISOString()}`];
		for (const c of r.checks) {
			lines.push(`[${WORD[c.state]}] ${c.label}: ${c.message}`);
			for (const d of c.details ?? []) lines.push(`    [${WORD[d.state]}] ${d.label}: ${d.text}`);
		}
		return lines.join('\n');
	}

	async function copy() {
		if (!report) return;
		try {
			await navigator.clipboard.writeText(asText(report));
			copied = true;
		} catch {
			copied = false;
		}
	}
</script>

<div class="fp-panel diag">
	<div class="diag__bar">
		<button type="button" class="fp-btn fp-btn--primary" onclick={run} disabled={busy}>
			{busy ? 'Checking…' : report ? 'Check again' : 'Check everything'}
		</button>
		<div class="t-ui" aria-live="polite">
			{#if busy}
				<span class="t-muted">Asking Caddy, Porkbun and the collector…</span>
			{:else if report && summary}
				{#if summary.error === 0 && summary.warning === 0}
					<Tag kind="success">All good</Tag>
				{:else}
					{#if summary.error}<Tag kind="error"
							>{summary.error} {summary.error === 1 ? 'problem' : 'problems'}</Tag
						>{/if}
					{#if summary.warning}<Tag kind="warning">{summary.warning} to check</Tag>{/if}
				{/if}
				<span class="t-muted"
					>Checked {formatDateTime(report.at, timeZone)}, in {formatMs(report.tookMs)}.</span
				>
			{:else}
				<span class="t-muted"
					>The admin API, metrics, the access log, paths, Porkbun, the collector, certificates, the database
					and slow page loads.</span
				>
			{/if}
		</div>
		{#if report}
			<button type="button" class="fp-btn fp-btn--quiet" onclick={copy}
				>{copied ? 'Copied' : 'Copy as text'}</button
			>
		{/if}
	</div>
	{#if failed}<Notice kind="error">{failed}</Notice>{/if}
	{#if report}
		<ul class="checks">
			{#each report.checks as c (c.id)}
				<li class="check" data-check={c.id}>
					<div class="check__head">
						<Tag kind={TAG[c.state]}>{WORD[c.state]}</Tag>
						<span class="t-ui check__label">{c.label}</span>
					</div>
					<p class="t-ui check__msg">
						{c.message}
						{#if c.fix}<a class="inline-link" href={c.fix.href}>{c.fix.label}</a>{/if}
					</p>
					{#if c.details?.length}
						<ul class="details">
							{#each c.details as d, i (i)}
								<li class="t-caption">
									<span class="dot dot--{d.state}" aria-hidden="true"></span>
									<span class="visually-hidden">{WORD[d.state]}:</span>
									<b>{d.label}</b>
									{d.text}
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.diag {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.diag__bar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.diag__bar > div {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		flex: 1 1 16rem;
	}
	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.check {
		display: grid;
		grid-template-columns: minmax(10rem, 14rem) 1fr;
		gap: var(--space-1) var(--space-4);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--line-soft);
	}
	.check:first-child {
		border-top: 0;
	}
	.check__head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.check__label {
		font-weight: 600;
	}
	.check__msg {
		margin: 0;
	}
	.details {
		grid-column: 2;
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		overflow-wrap: anywhere;
	}
	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-right: var(--space-1);
		background: var(--success-ink);
	}
	.dot--warning {
		background: var(--warning-ink);
	}
	.dot--error {
		background: var(--error-ink);
	}
	.dot--off {
		background: var(--faint);
	}
	.inline-link {
		text-decoration: underline;
		text-underline-offset: 3px;
		margin-left: var(--space-1);
	}
	@media (max-width: 640px) {
		.check {
			grid-template-columns: 1fr;
		}
		.details {
			grid-column: 1;
		}
	}
</style>
