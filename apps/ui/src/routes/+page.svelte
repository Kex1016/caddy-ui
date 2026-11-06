<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Notice, PageHero, StatTile, Tag } from '$lib/design/components';
	import { BarList, LineChart, RangeSwitch, Sparkline, ViewSwitch, viewParam } from '$lib/design/charts';
	import type { RangeKey } from '$lib/design/charts';
	import {
		formatBytes,
		formatCompact,
		formatDate,
		formatDateTime,
		formatElapsed,
		formatMs,
		formatNumber
	} from '$lib/format';
	import { frameFor, missingLine, sourceNote, sourceNotices } from '$lib/stats/sources';
	import { RANGE_LABEL, autoRefresh, pct, statusKind, statusLine, stepLabel } from '$lib/stats/view';

	let { data } = $props();
	onMount(() => autoRefresh());

	const ov = $derived(data.overview);
	const tz = $derived(data.timeZone);
	const view = $derived(viewParam(page.url));
	const now = $derived(ov.asOf);
	const per = $derived(stepLabel(ov.stepMs));
	const rangeWords = $derived(RANGE_LABEL[ov.range] ?? ov.range);
	const sources = $derived({ ...ov.sources, admin: { ok: data.adminOk } });
	const notices = $derived(sourceNotices(sources));
	const t = $derived(ov.tiles);
	const common = $derived({ timeZone: tz, view, stepMs: ov.stepMs });
	const frame = (s: (typeof ov.series)['requests'], kind: 'traffic' | 'process' = 'traffic') =>
		frameFor(s, sources, now, kind);
	const topFrame = $derived({
		timeZone: tz,
		view,
		asOf: now,
		note: sourceNote(ov.top ? 'logs' : null),
		emptyTitle: 'No access log data',
		emptyLine: missingLine('top', sources)
	});
</script>

<PageHero
	kicker="Server"
	title="Overview"
	lede="Requests, errors, latency and uptime for the whole Caddy server, with what needs attention first."
/>

{#if data.down.length > 0}
	<section class="fp-section">
		<Notice kind="error">
			<b>{data.down.length === 1 ? 'One site is down.' : `${data.down.length} sites are down.`}</b>
			{#each data.down as s, i (s.id)}{i > 0 ? ', ' : ' '}<a class="inline-link" href="/sites/{s.id}"
					>{s.label}</a
				>
				<span class="t-muted">({statusLine('down', s.since, now).toLowerCase()})</span>{/each}
		</Notice>
	</section>
{/if}
{#each notices as n (n.title)}
	<section class="fp-section">
		<Notice kind={n.kind}><b>{n.title}</b> {n.line}</Notice>
	</section>
{/each}

<section class="fp-section">
	<div class="fp-section__head">
		<h2 class="t-title-2">Right now</h2>
		<div class="controls">
			<RangeSwitch url={page.url} range={ov.range as RangeKey} />
			<ViewSwitch url={page.url} {view} />
		</div>
	</div>
	<div class="fp-tiles">
		<StatTile
			label="Sites up"
			value={formatNumber(t.sites.up)}
			unit=" of {formatNumber(t.sites.total)}"
			note={t.sites.down > 0
				? `${t.sites.down} down${t.sites.unknown ? ` · ${t.sites.unknown} not probed` : ''}`
				: t.sites.unknown > 0
					? `${t.sites.unknown} not probed yet`
					: 'all up · from probes'}
			href="/sites"
		/>
		<StatTile
			label="Upstreams up"
			value={formatNumber(t.upstreams.up)}
			unit=" of {formatNumber(t.upstreams.up + t.upstreams.down + t.upstreams.unknown)}"
			note={t.upstreams.down > 0 ? `${t.upstreams.down} down` : 'from probes'}
		/>
		<StatTile
			label="Requests"
			value={t.requests.value === null ? '—' : formatNumber(t.requests.value)}
			note="{rangeWords}{t.requests.source
				? ` · ${t.requests.source === 'logs' ? 'access log' : 'metrics'}`
				: ' · no source'}"
		>
			{#snippet spark()}<Sparkline
					points={ov.series.requests.points}
					label="Requests {per}, {rangeWords}"
				/>{/snippet}
		</StatTile>
		<StatTile
			label="5xx error rate"
			value={pct(t.errorRate.value)}
			note="{rangeWords}{t.errorRate.source ? '' : ' · no source'}"
		/>
		<StatTile
			label="Latency p95"
			value={t.latencyP95.value === null ? '—' : formatMs(t.latencyP95.value)}
			note="{rangeWords} · request-weighted"
		/>
		<StatTile
			label="Caddy up for"
			value={t.caddyStartedAt.value === null ? '—' : formatElapsed(now - t.caddyStartedAt.value)}
			note={t.caddyStartedAt.value === null
				? 'needs /metrics'
				: `since ${formatDateTime(t.caddyStartedAt.value, tz)}`}
		/>
		<StatTile
			label="Next certificate expiry"
			value={t.certs.soonest ? formatNumber(t.certs.soonest.daysLeft) : '—'}
			unit={t.certs.soonest ? ' days' : undefined}
			note={t.certs.soonest
				? `${t.certs.soonest.host}${t.certs.expiringSoon ? ` · ${t.certs.expiringSoon} within ${t.certs.warnDays} days` : ''}`
				: 'no certificates read'}
		/>
	</div>
</section>

<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">Traffic</h2></div>
	<div class="fp-panels">
		<LineChart
			{...common}
			{...frame(ov.series.requests)}
			title="Requests"
			sub="whole server · {per}"
			label="Requests"
			series={ov.series.requests}
			format={formatNumber}
			tick={formatCompact}
		/>
		<LineChart
			{...common}
			{...frame(ov.series.errors5xx)}
			title="Errors"
			sub="whole server · {per}"
			label="5xx"
			series={ov.series.errors5xx}
			shadow={{ label: '4xx', series: ov.series.errors4xx }}
			format={formatNumber}
			tick={formatCompact}
		/>
		<LineChart
			{...common}
			{...frame(ov.series.latencyP95)}
			title="Latency"
			sub="whole server · request-weighted"
			label="p95"
			series={ov.series.latencyP95}
			shadow={{ label: 'p50', series: ov.series.latencyP50 }}
			format={formatMs}
		/>
		<LineChart
			{...common}
			{...frame(ov.series.bytesOut)}
			title="Bytes out"
			sub="whole server · {per}"
			label="Bytes out"
			series={ov.series.bytesOut}
			format={formatBytes}
		/>
		<LineChart
			{...common}
			{...frame(ov.series.inFlight)}
			title="Requests in flight"
			sub="whole server · peak {per}"
			label="In flight"
			series={ov.series.inFlight}
			format={formatNumber}
			tick={formatCompact}
		/>
	</div>
</section>

<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">Busiest</h2></div>
	<div class="fp-panels">
		<BarList
			timeZone={tz}
			{view}
			asOf={now}
			note={sourceNote(ov.topSites[0]?.source)}
			title="Sites by requests"
			sub={rangeWords}
			valueLabel="Requests"
			emptyTitle="No per-site traffic"
			emptyLine={missingLine('traffic', sources)}
			rows={ov.topSites.map((s) => ({
				key: s.siteId,
				label: s.label,
				v: s.requests,
				display: formatNumber(s.requests),
				href: `/sites/${s.siteId}`
			}))}
		/>
		<BarList
			{...topFrame}
			title="Top paths"
			sub="{rangeWords} · all sites"
			valueLabel="Requests"
			rows={(ov.top?.paths ?? []).map(([p, n]) => ({ key: p, label: p, v: n, display: formatNumber(n) }))}
		/>
		<BarList
			{...topFrame}
			title="Top client IPs"
			sub="{rangeWords} · all sites"
			valueLabel="Requests"
			rows={(ov.top?.ips ?? []).map(([ip, n]) => ({ key: ip, label: ip, v: n, display: formatNumber(n) }))}
		/>
	</div>
</section>

<section class="fp-section">
	<div class="fp-section__head">
		<h2 class="t-title-2">Upstreams</h2>
		<span class="t-caption t-faint">{data.upstreams.length} behind {formatNumber(t.sites.total)} sites</span>
	</div>
	{#if data.upstreams.length === 0}
		<p class="t-body t-muted">No reverse_proxy, forward_auth or php_fastcgi upstreams in the Caddyfile.</p>
	{:else}
		<div class="fp-panel fp-table__wrap">
			<table class="fp-table">
				<caption class="visually-hidden">Upstreams, down first</caption>
				<thead>
					<tr>
						<th scope="col">State</th>
						<th scope="col">Upstream</th>
						<th scope="col">Used by</th>
						<th scope="col" class="num">Probe</th>
						<th scope="col" class="num" title="From Caddy's /reverse_proxy/upstreams">Active</th>
						<th scope="col" class="num" title="Passive health check failures Caddy remembers">Fails</th>
					</tr>
				</thead>
				<tbody>
					{#each data.upstreams as u (u.address)}
						<tr>
							<td>
								<Tag kind={statusKind(u.status)}>{u.status === 'unknown' ? 'not probed' : u.status}</Tag>
								<div class="t-caption t-faint">{statusLine(u.status, u.since, now)}</div>
							</td>
							<td>
								<span class="t-num">{u.address}</span>
								<div class="t-caption t-faint">{u.via.join(', ')}</div>
								{#if u.status === 'down' && u.error}<div class="t-caption t-muted">{u.error}</div>{/if}
							</td>
							<td>
								{#each u.sites.slice(0, 3) as s, i (s.id)}{i > 0 ? ', ' : ''}<a href="/sites/{s.id}"
										>{s.label}</a
									>{/each}{#if u.sites.length > 3}<span class="t-muted">
										and {u.sites.length - 3} more</span
									>{/if}
							</td>
							<td class="num">{u.latencyMs === null ? '—' : formatMs(u.latencyMs)}</td>
							<td class="num">{u.activeRequests === null ? '—' : formatNumber(u.activeRequests)}</td>
							<td class="num">{u.fails === null ? '—' : formatNumber(u.fails)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if !data.adminOk}
			<p class="t-caption t-faint">Active and Fails need Caddy's admin API, which is not answering.</p>
		{/if}
	{/if}
</section>

<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">Caddy process</h2></div>
	<div class="fp-panels">
		<LineChart
			{...common}
			{...frame(ov.series.memory, 'process')}
			title="Memory"
			sub="resident set size · peak {per}"
			label="Memory"
			series={ov.series.memory}
			format={formatBytes}
		/>
		<LineChart
			{...common}
			{...frame(ov.series.goroutines, 'process')}
			title="Goroutines"
			sub="peak {per}"
			label="Goroutines"
			series={ov.series.goroutines}
			format={formatNumber}
			tick={formatCompact}
		/>
		<BarList
			timeZone={tz}
			{view}
			asOf={now}
			note="From certificate files in Caddy's data directory"
			title="Certificates"
			sub="soonest expiry first · warns under {t.certs.warnDays} days"
			valueLabel="Days left"
			emptyTitle="No certificates read"
			emptyLine={sources.certs.error ??
				"Mount Caddy's data directory read-only and set CADDY_DATA_PATH to read expiry dates."}
			rows={ov.certs.map((c) => ({
				key: c.host,
				label: c.host,
				v: Math.max(0, c.daysLeft),
				display: c.daysLeft < 0 ? 'expired' : `${formatNumber(c.daysLeft)} d`,
				sub: `${c.daysLeft < t.certs.warnDays ? 'renewal due · ' : ''}${formatDate(c.notAfter, tz)}${c.issuer ? ` · ${c.issuer}` : ''}`
			}))}
		/>
	</div>
</section>

<style>
	/* Links inside a sentence need more than colour to stand out (WCAG 1.4.1). */
	.inline-link {
		text-decoration: underline;
	}
	.controls {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	td a {
		color: inherit;
	}
</style>
