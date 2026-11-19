<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Notice, PageHero, StatTile, Tag } from '$lib/design/components';
	import {
		BarList,
		LineChart,
		RangeSwitch,
		Sparkline,
		StripPlot,
		UptimeStrip,
		ViewSwitch,
		viewParam
	} from '$lib/design/charts';
	import type { RangeKey } from '$lib/design/charts';
	import {
		formatBytes,
		formatCompact,
		formatDate,
		formatDateTime,
		formatMs,
		formatNumber,
		formatPercent,
		formatTime
	} from '$lib/format';
	import { frameFor, isStale, missingLine, sourceNote, sourceNotices } from '$lib/stats/sources';
	import {
		RANGE_LABEL,
		autoRefresh,
		errorRate,
		pct,
		statusKind,
		statusLine,
		stepLabel
	} from '$lib/stats/view';
	import SiteDns from './SiteDns.svelte';

	let { data, form } = $props();
	onMount(() => autoRefresh());

	const st = $derived(data.stats);
	const site = $derived(data.site);
	const tz = $derived(data.timeZone);
	const view = $derived(viewParam(page.url));
	const now = $derived(st.asOf);
	const per = $derived(stepLabel(st.stepMs));
	const rangeWords = $derived(RANGE_LABEL[st.range] ?? st.range);
	const sources = $derived({ ...st.sources, admin: { ok: data.adminOk } });
	const notices = $derived(sourceNotices(sources));
	const label = $derived(st.site.addresses[0] ?? st.site.id);
	const common = $derived({ timeZone: tz, view, stepMs: st.stepMs });
	const frame = (s: (typeof st.series)['requests'], kind: 'traffic' | 'probes' = 'traffic') =>
		frameFor(s, sources, now, kind);
	const probeStale = $derived(isStale('probes', sources, now));
	const upstreamView = (address: string) => site?.upstreams.find((u) => u.address === address) ?? null;
	const topFrame = $derived({
		timeZone: tz,
		view,
		asOf: now,
		note: sourceNote(st.top ? 'logs' : null),
		emptyTitle: 'No access log data',
		emptyLine: missingLine('top', sources)
	});
</script>

<PageHero
	kicker="Site"
	title={label}
	lede={st.site.addresses.length > 1 ? st.site.addresses.join(', ') : undefined}
/>

{#if st.site.removedAt !== null || !site}
	<section class="fp-section">
		<Notice>
			<b>No longer in the Caddyfile.</b>
			{st.site.removedAt !== null ? `Removed ${formatDateTime(st.site.removedAt, tz)}.` : ''} Its history is kept
			and shown below.
		</Notice>
	</section>
{/if}
{#each notices as n (n.title)}
	<section class="fp-section">
		<Notice kind={n.kind}><b>{n.title}</b> {n.line}</Notice>
	</section>
{/each}

{#if site}
	<section class="fp-section">
		<div class="fp-panel status">
			<div class="status__main">
				<Tag kind={statusKind(site.status)}>{site.status === 'unknown' ? 'not probed' : site.status}</Tag>
				<span class="t-title-3">{statusLine(site.status, site.since, now)}</span>
			</div>
			<dl class="status__facts">
				<div>
					<dt class="t-kicker t-faint">Last probe</dt>
					<dd class="t-ui">
						{#if site.probe}
							{site.probe.ok ? 'Answered' : 'Failed'}{site.probe.status
								? ` HTTP ${site.probe.status}`
								: ''}{site.probe.latencyMs !== null ? ` in ${formatMs(site.probe.latencyMs)}` : ''} at {formatTime(
								site.probe.ts,
								tz
							)}
							{#if site.probe.error}<span class="t-muted"> · {site.probe.error}</span>{/if}
						{:else}
							No probe yet
						{/if}
					</dd>
				</div>
				<div>
					<dt class="t-kicker t-faint">Certificate</dt>
					<dd class="t-ui">
						{#if site.cert}
							{site.cert.daysLeft < 0 ? 'Expired' : `Expires in ${formatNumber(site.cert.daysLeft)} days`}, {formatDate(
								site.cert.notAfter,
								tz
							)}{site.cert.issuer ? ` · ${site.cert.issuer}` : ''}
							{#if site.cert.daysLeft < data.certWarnDays}<Tag kind="warning">renewal due</Tag>{/if}
						{:else}
							None read for this address
						{/if}
					</dd>
				</div>
				<div>
					<dt class="t-kicker t-faint">Caddyfile</dt>
					<dd class="t-ui">
						<a href="/editor?site={site.id}">Line {formatNumber(site.line)}, open in the editor</a>
					</dd>
				</div>
			</dl>
		</div>
	</section>
	{#if data.porkbunOn}
		<SiteDns siteId={site.id} addresses={st.site.addresses} timeZone={tz} {form} />
	{/if}
{/if}

<section class="fp-section">
	<div class="fp-section__head">
		<h2 class="t-title-2">Over the {rangeWords}</h2>
		<div class="controls">
			<RangeSwitch url={page.url} range={st.range as RangeKey} defaultRange={data.display.range} />
			<ViewSwitch url={page.url} {view} />
		</div>
	</div>
	<div class="fp-tiles">
		<StatTile label="Uptime" value={pct(st.uptime.ratio)} note="{rangeWords} · from probes" />
		<StatTile
			label="Requests"
			value={st.totals.requests === null ? '—' : formatNumber(st.totals.requests)}
			note="{rangeWords}{st.series.requests.source
				? ` · ${st.series.requests.source === 'logs' ? 'access log' : 'metrics'}`
				: ' · no source'}"
		>
			{#snippet spark()}<Sparkline
					points={st.series.requests.points}
					label="Requests {per}, {rangeWords}"
				/>{/snippet}
		</StatTile>
		<StatTile
			label="5xx error rate"
			value={pct(errorRate(st.totals.requests, st.totals.errors5xx))}
			note="{st.totals.errors5xx === null ? '—' : formatNumber(st.totals.errors5xx)} 5xx · {st.totals
				.errors4xx === null
				? '—'
				: formatNumber(st.totals.errors4xx)} 4xx"
		/>
		<StatTile
			label="Latency p95"
			value={st.totals.latencyP95 === null ? '—' : formatMs(st.totals.latencyP95)}
			note="p50 {st.totals.latencyP50 === null ? '—' : formatMs(st.totals.latencyP50)} · request-weighted"
		/>
		<StatTile
			label="Bytes out"
			value={st.totals.bytesOut === null ? '—' : formatBytes(st.totals.bytesOut)}
			note={rangeWords}
		/>
	</div>
	<UptimeStrip
		timeZone={tz}
		{view}
		asOf={probeStale ? (sources.probes.lastRun ?? now) : now}
		stale={probeStale}
		note={sourceNote('probes')}
		title="Uptime"
		sub="{rangeWords} · one cell {per}"
		cells={st.uptime.strip}
		ratio={st.uptime.ratio}
		stepMs={st.stepMs}
		from={st.from}
		to={st.to}
		emptyLine={missingLine('probes', sources)}
	/>
</section>

{#if st.upstreams.length > 0}
	<section class="fp-section">
		<div class="fp-section__head">
			<h2 class="t-title-2">Upstreams</h2>
			<span class="t-caption t-faint">from the UI's probes{data.adminOk ? " and Caddy's admin API" : ''}</span
			>
		</div>
		<ul class="fp-panel upstreams">
			{#each st.upstreams as u (u.address)}
				{@const live = upstreamView(u.address)}
				<li>
					<div class="upstream__head">
						<Tag kind={statusKind(live?.status ?? 'unknown')}
							>{live?.status === 'up' ? 'up' : live?.status === 'down' ? 'down' : 'not probed'}</Tag
						>
						<span class="t-num upstream__addr">{u.address}</span>
						<span class="t-caption t-faint">{live?.via ?? ''}</span>
						<span class="upstream__end t-caption t-muted">
							{live ? statusLine(live.status, live.since, now) : ''}{live?.probe?.latencyMs != null
								? ` · ${formatMs(live.probe.latencyMs)}`
								: ''}{live?.activeRequests != null
								? ` · ${formatNumber(live.activeRequests)} active`
								: ''}{live?.fails ? ` · ${formatNumber(live.fails)} fails` : ''} · {u.uptime === null
								? 'no data'
								: `${formatPercent(u.uptime)} up`}
						</span>
					</div>
					{#if live?.status === 'down' && live.probe?.error}<p class="t-caption t-muted">
							{live.probe.error}
						</p>{/if}
					{#if view === 'charts'}
						<StripPlot
							cells={u.strip}
							stepMs={st.stepMs}
							timeZone={tz}
							label="{u.address}: {u.uptime === null
								? 'no data'
								: `up ${formatPercent(u.uptime)} of the time`}, {rangeWords}"
							height={16}
						/>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">Traffic</h2></div>
	<div class="fp-panels">
		<LineChart
			{...common}
			{...frame(st.series.requests)}
			title="Requests"
			sub={per}
			label="Requests"
			series={st.series.requests}
			format={formatNumber}
			tick={formatCompact}
		/>
		<LineChart
			{...common}
			{...frame(st.series.errors5xx)}
			title="Errors"
			sub={per}
			label="5xx"
			series={st.series.errors5xx}
			shadow={{ label: '4xx', series: st.series.errors4xx }}
			format={formatNumber}
			tick={formatCompact}
		/>
		<LineChart
			{...common}
			{...frame(st.series.latencyP95)}
			title="Latency"
			sub="request-weighted"
			label="p95"
			series={st.series.latencyP95}
			shadow={{ label: 'p50', series: st.series.latencyP50 }}
			format={formatMs}
		/>
		<LineChart
			{...common}
			{...frame(st.series.bytesOut)}
			title="Bytes out"
			sub={per}
			label="Bytes out"
			series={st.series.bytesOut}
			format={formatBytes}
		/>
		<LineChart
			{...common}
			{...frame(st.series.inFlight)}
			title="Requests in flight"
			sub="peak {per}"
			label="In flight"
			series={st.series.inFlight}
			format={formatNumber}
			tick={formatCompact}
		/>
		<LineChart
			{...common}
			{...frame(st.series.probeLatency, 'probes')}
			title="Probe latency"
			sub="through Caddy · mean {per}"
			label="Probe"
			series={st.series.probeLatency}
			format={formatMs}
		/>
	</div>
</section>

<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">Top</h2></div>
	<div class="fp-panels">
		<BarList
			{...topFrame}
			title="Top paths"
			sub={rangeWords}
			valueLabel="Requests"
			rows={(st.top?.paths ?? []).map(([p, n]) => ({ key: p, label: p, v: n, display: formatNumber(n) }))}
		/>
		<BarList
			{...topFrame}
			title="Top client IPs"
			sub={rangeWords}
			valueLabel="Requests"
			rows={(st.top?.ips ?? []).map(([ip, n]) => ({ key: ip, label: ip, v: n, display: formatNumber(n) }))}
		/>
	</div>
</section>

<style>
	.controls {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.status {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.status__main {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.status__facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: var(--space-4);
		margin: 0;
	}
	.status__facts dd {
		margin: var(--space-1) 0 0;
	}
	.upstreams {
		list-style: none;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.upstreams li {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.upstreams p {
		margin: 0;
	}
	.upstream__head {
		display: flex;
		align-items: baseline;
		gap: var(--space-2) var(--space-3);
		flex-wrap: wrap;
	}
	.upstream__addr {
		overflow-wrap: anywhere;
	}
	.upstream__end {
		margin-left: auto;
	}
</style>
