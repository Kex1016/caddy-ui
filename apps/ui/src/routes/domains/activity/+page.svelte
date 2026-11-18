<script lang="ts">
	import type { AuditEntry } from '$lib/api/porkbun';
	import { EmptyState, PageHero, Tag } from '$lib/design/components';
	import { formatDateTime } from '$lib/format';
	import { domainHref } from '$lib/porkbun/tabs';

	let { data } = $props();

	const pretty = (value: unknown) => JSON.stringify(value, null, 2);

	function failure(entry: AuditEntry): string {
		const result = entry.result as { error?: { code?: unknown; message?: unknown } } | null;
		const code = typeof result?.error?.code === 'string' ? result.error.code : '';
		const message = typeof result?.error?.message === 'string' ? result.error.message : '';
		return [code, message].filter(Boolean).join(': ');
	}

	const olderHref = $derived(
		data.log.nextBefore === null
			? null
			: `?${new URLSearchParams({
					...(data.domain ? { domain: data.domain } : {}),
					before: String(data.log.nextBefore)
				})}`
	);
</script>

<PageHero
	kicker="Porkbun"
	title="Activity"
	lede="Every change this UI has sent to Porkbun, newest first, with what was there before. Changes made at porkbun.com or by Caddy itself are not listed."
/>

{#if data.domain}
	<p class="t-ui">
		Showing <span class="t-mono">{data.domain}</span> only. <a href="/domains/activity">Show every domain</a>
	</p>
{/if}

{#if data.log.entries.length === 0}
	<section class="fp-section">
		<EmptyState
			title={data.paged ? 'Nothing older' : 'No changes yet'}
			line={data.paged
				? 'That was the end of the list.'
				: 'Each change made from the Domains pages is kept here, whether Porkbun accepted it or not.'}
		/>
	</section>
{:else}
	<section class="fp-section">
		<div class="fp-panel fp-table__wrap">
			<table class="fp-table">
				<caption class="visually-hidden">Changes sent to Porkbun, newest first</caption>
				<thead>
					<tr>
						<th scope="col">When</th>
						<th scope="col">Who</th>
						<th scope="col">Domain</th>
						<th scope="col">Action</th>
						<th scope="col">Result</th>
						<th scope="col">Details</th>
					</tr>
				</thead>
				<tbody>
					{#each data.log.entries as entry (entry.id)}
						<tr>
							<td class="when">{formatDateTime(entry.ts, data.timeZone)}</td>
							<td class="cell">{entry.author}</td>
							<td class="t-mono cell">
								{#if entry.domain}<a href={domainHref(entry.domain)}>{entry.domain}</a>{:else}<span
										class="t-muted">account</span
									>{/if}
							</td>
							<td class="t-mono cell">{entry.action}</td>
							<td>
								{#if entry.ok}
									<Tag kind="success">applied</Tag>
								{:else}
									<Tag kind="error">failed</Tag>
									<div class="t-ui t-muted why">{failure(entry)}</div>
								{/if}
							</td>
							<td>
								<details>
									<summary class="t-ui">Request{entry.before === null ? '' : ' and state before'}</summary>
									<p class="t-caption">Request</p>
									<pre class="json">{pretty(entry.request)}</pre>
									{#if entry.before !== null}
										<p class="t-caption">Before</p>
										<pre class="json">{pretty(entry.before)}</pre>
									{/if}
									<p class="t-caption">Result</p>
									<pre class="json">{pretty(entry.result)}</pre>
									{#if entry.requestId}<p class="t-caption">Porkbun request {entry.requestId}</p>{/if}
								</details>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if olderHref}<p><a class="fp-btn" href={olderHref}>Older changes</a></p>{/if}
	</section>
{/if}

<style>
	.when,
	.cell {
		white-space: nowrap;
	}
	.why {
		margin-top: var(--space-1);
		min-width: 220px;
		max-width: 320px;
		overflow-wrap: anywhere;
	}
	td {
		vertical-align: top;
	}
	summary {
		cursor: pointer;
		white-space: nowrap;
	}
	.json {
		margin: var(--space-1) 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		background: var(--sunk);
		font: 400 12px/18px var(--font-mono);
		max-width: 420px;
		max-height: 240px;
		overflow: auto;
		white-space: pre;
	}
</style>
