<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { EditableSetting, SettingsError, SettingsView } from '$lib/api/settings';
	import type { CaddyStatus } from '$lib/api/config';
	import type { PorkbunStatus } from '$lib/api/porkbun';
	import { AsOf, EmptyState, Notice, PageHero, StatTile, Tag } from '$lib/design/components';
	import { DISPLAY_LABELS, LANDING_PAGES, type Display, type DisplayKey } from '$lib/display';
	import { ChevronDown } from '@lucide/svelte';
	import { formatBytes, formatDate, formatDateTime, formatMs, formatNumber } from '$lib/format';
	import CaddyHelpers from '$lib/settings/components/CaddyHelpers.svelte';
	import DiagnosticsPanel from '$lib/settings/components/DiagnosticsPanel.svelte';
	import ProbeOptionsTable from '$lib/settings/components/ProbeOptionsTable.svelte';
	import SettingField from '$lib/settings/components/SettingField.svelte';
	import StorageTools from '$lib/settings/components/StorageTools.svelte';
	import {
		ENV_LABELS,
		FIELDS,
		SECTION_KEYS,
		editable,
		envOnly,
		envOnlyText,
		rowsOlderThan,
		startValue,
		tableLabel,
		type SectionId
	} from '$lib/settings/meta';
	import type { StorageMeasure } from '$lib/settings/types';
	import { RESULT_TAG, TRIGGER_TEXT, channelNotice, intervalText } from '$lib/settings/updates';

	let { data, form } = $props();

	const view = $derived<SettingsView>(data.view);

	// Display preferences (S6): saved on the server, so they follow this person to another browser.
	const prefFields: { key: DisplayKey; label: string; hint: string; choices: [string, string][] }[] = [
		{
			key: 'range',
			label: 'Stats range',
			hint: 'The range Overview and each site open on. A range in the address still wins.',
			choices: Object.entries(DISPLAY_LABELS.range)
		},
		{
			key: 'clock',
			label: 'Clock',
			hint: 'How times of day are written.',
			choices: Object.entries(DISPLAY_LABELS.clock)
		},
		{
			key: 'dateFormat',
			label: 'Date format',
			hint: 'How dates are written. The example is 4 November 2026.',
			choices: Object.entries(DISPLAY_LABELS.dateFormat)
		},
		{
			key: 'landing',
			label: 'Landing page',
			hint: 'Where the bare address opens when you type it, follow a bookmark or arrive from another site.',
			choices: LANDING_PAGES.map((p) => [p.value, p.label])
		},
		{
			key: 'theme',
			label: 'Theme',
			hint: 'The default for every browser. A browser that has used the theme button keeps its own choice.',
			choices: Object.entries(DISPLAY_LABELS.theme)
		},
		{
			key: 'sidebar',
			label: 'Sidebar',
			hint: 'The default for every browser. A browser that has resized the sidebar keeps its own choice.',
			choices: Object.entries(DISPLAY_LABELS.sidebar)
		}
	];
	const shown = $derived<Display>(data.display);
	const overrideNames = $derived(
		[data.prefs.overrides.theme && 'theme', data.prefs.overrides.sidebar && 'sidebar']
			.filter(Boolean)
			.join(' and ')
	);
	const overridden = $derived(data.prefs.overrides.theme || data.prefs.overrides.sidebar);
	const locked = $derived(view.ignoringSaved);

	// Sections in the order of docs/settings-and-perf-plan.md §2.3. S3 to S6 add theirs (diagnostics, storage tools,
	// thresholds, notifications, updates, display preferences, export and import) to this list and the markup.
	const NAV = [
		{ id: 'diagnostics', label: 'Diagnostics' },
		{ id: 'monitoring', label: 'Monitoring' },
		{ id: 'storage', label: 'Data and storage' },
		{ id: 'helpers', label: 'Caddy helpers' },
		{ id: 'display', label: 'Display' },
		{ id: 'preferences', label: 'Preferences' },
		{ id: 'domains', label: 'Domains' },
		{ id: 'connections', label: 'Connections' },
		{ id: 'sign-in', label: 'Sign-in' },
		{ id: 'updates', label: 'Updates' },
		{ id: 'changes', label: 'Recent changes' }
	];

	// What is typed but not saved yet, per key. Absent means "as saved".
	let drafts = $state<Record<string, string>>({});
	let errors = $state<Record<string, string>>({});
	let busy = $state<string | null>(null);
	let done = $state<{ section: SectionId; text: string } | null>(null);
	let failed = $state<{ section: SectionId; text: string } | null>(null);

	const rowOf = (key: string) => editable(view, key) as EditableSetting;
	const valueOf = (key: string) => drafts[key] ?? startValue(rowOf(key), locked);
	const isDirty = (key: string) =>
		drafts[key] !== undefined && drafts[key].trim() !== startValue(rowOf(key), locked).trim();
	const dirtyKeys = (section: SectionId) => SECTION_KEYS[section].filter((k) => isDirty(k));

	function sectionOf(key: string): SectionId {
		return (Object.keys(SECTION_KEYS) as SectionId[]).find((s) =>
			(SECTION_KEYS[s] as readonly string[]).includes(key)
		) as SectionId;
	}

	async function patch(body: Record<string, string | null>): Promise<SettingsError | null> {
		try {
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (res.ok) return null;
			const err = (await res.json().catch(() => null)) as SettingsError | null;
			return err ?? { message: `The UI answered ${res.status}.`, code: 'INVALID' };
		} catch {
			return { message: 'This UI could not be reached.', code: 'INVALID' };
		}
	}

	function forget(keys: readonly string[]) {
		const d = { ...drafts };
		const e = { ...errors };
		for (const k of keys) {
			delete d[k];
			delete e[k];
		}
		drafts = d;
		errors = e;
	}

	async function save(section: SectionId) {
		const keys = dirtyKeys(section);
		done = null;
		failed = null;
		if (keys.length === 0) return;
		busy = section;
		const body: Record<string, string> = {};
		for (const k of keys) body[k] = (drafts[k] as string).trim();
		const err = await patch(body);
		if (err) {
			const e = { ...errors };
			for (const k of SECTION_KEYS[section]) delete e[k];
			if (err.errors) Object.assign(e, err.errors);
			errors = e;
			if (!err.errors) failed = { section, text: err.message };
		} else {
			await invalidateAll();
			forget(keys);
			done = { section, text: keys.length === 1 ? 'Saved. It applies now.' : 'Saved. They apply now.' };
		}
		busy = null;
	}

	async function reset(key: string) {
		const section = sectionOf(key);
		done = null;
		failed = null;
		busy = key;
		const err = await patch({ [key]: null });
		if (err) failed = { section, text: err.message };
		else {
			await invalidateAll();
			forget([key]);
			done = {
				section,
				text: `${FIELDS[key]?.label ?? key} uses the ${rowOf(key).source === 'env' ? 'environment’s value' : 'default'} again.`
			};
		}
		busy = null;
	}

	// The zone list fills after hydration, so the server's list and the browser's never have to match.
	let timeZones = $state<string[]>([]);
	$effect(() => {
		try {
			timeZones = Intl.supportedValuesOf('timeZone');
		} catch {
			timeZones = [];
		}
	});

	// Table sizes stream in when they were not measured in the last 15 minutes.
	let measured = $state<StorageMeasure | null>(null);
	$effect(() => {
		const t = data.tables;
		let live = true;
		Promise.resolve(t).then((m) => {
			if (live) measured = m;
		});
		return () => {
			live = false;
		};
	});
	let measuring = $state(false);

	const DAY = 86_400_000;
	const retention = $derived.by(() => {
		const row = rowOf('CADDY_UI_RETENTION_DAYS');
		const now = Number(row.value);
		const next = Number(valueOf('CADDY_UI_RETENTION_DAYS').trim());
		if (!Number.isInteger(next) || next < 1 || next >= now) return null;
		const cutoff = data.now - next * DAY;
		const oldest = data.storage.oldest.probes ?? null;
		if (oldest === null || oldest >= cutoff) return { cutoff, rows: 0, bytes: 0, known: true };
		let rows = 0;
		let bytes = 0;
		const known = !!measured && !measured.error;
		if (known) {
			for (const name of ['probes', 'metric_samples'] as const) {
				const t = measured?.tables.find((x) => x.name === name);
				const first = data.storage.oldest[name] ?? null;
				if (!t) continue;
				const n = rowsOlderThan(t.rows, first, next, data.now);
				rows += n;
				bytes += t.rows > 0 ? (t.bytes * n) / t.rows : 0;
			}
		}
		return { cutoff, rows, bytes, known };
	});

	const dbTotal = $derived(data.storage.fileBytes + data.storage.walBytes);

	// Updates: while a check is asked for or running, look at the updater's files every two seconds.
	const updates = $derived(data.updates);
	const notice = $derived(channelNotice(updates));
	const busyChecking = $derived(updates.checkPending || updates.status?.checking === true);
	let checkSent = $state(false);
	let checkError = $state<string | null>(null);
	$effect(() => {
		if (!busyChecking && !checkSent) return;
		const timer = setInterval(() => void invalidateAll(), 2000);
		return () => clearInterval(timer);
	});
	$effect(() => {
		// The request has been seen by the updater: stop polling at the fast pace once it is done.
		if (checkSent && updates.status && !busyChecking) checkSent = false;
	});

	// "Test" buttons.
	let adminTest = $state<{ busy: boolean; result: CaddyStatus | null; error: string | null }>({
		busy: false,
		result: null,
		error: null
	});
	async function testAdmin() {
		adminTest = { busy: true, result: null, error: null };
		try {
			const res = await fetch('/api/caddy/status');
			adminTest = { busy: false, result: (await res.json()) as CaddyStatus, error: null };
		} catch {
			adminTest = { busy: false, result: null, error: 'This UI could not be reached.' };
		}
	}

	let porkbunTest = $state<{ busy: boolean; result: PorkbunStatus | null; error: string | null }>({
		busy: false,
		result: null,
		error: null
	});
	async function testPorkbun() {
		porkbunTest = { busy: true, result: null, error: null };
		try {
			const res = await fetch('/api/porkbun/status?force');
			porkbunTest = { busy: false, result: (await res.json()) as PorkbunStatus, error: null };
		} catch {
			porkbunTest = { busy: false, result: null, error: 'This UI could not be reached.' };
		}
	}

	const keysSet = $derived(
		!!envOnly(view, 'PORKBUN_API_KEY')?.set && !!envOnly(view, 'PORKBUN_API_SECRET_KEY')?.set
	);

	let checking = $state(false);
	async function recheck() {
		checking = true;
		await invalidateAll();
		checking = false;
	}

	const AUTH_TEXT: Record<string, string> = {
		local: 'Local user and password',
		forward: 'Forward auth: the proxy in front signs people in',
		none: 'None: the proxy in front is trusted to sign people in',
		'local-disabled': 'Off: local mode with no user and password set'
	};

	const envRows = (keys: string[]) =>
		keys.map((k) => envOnly(view, k)).filter((r): r is NonNullable<typeof r> => !!r);

	const pathState = { ok: 'success', warning: 'warning', error: 'error' } as const;
	const pathTag = { ok: 'OK', warning: 'Check', error: 'Problem' } as const;

	const logText = (v: string | null) => (v === null ? 'nothing saved' : v === '' ? 'empty' : v);
</script>

{#snippet envTable(caption: string, keys: string[])}
	<div class="fp-panel fp-table__wrap">
		<table class="fp-table">
			<caption class="visually-hidden">{caption}</caption>
			<thead>
				<tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">From</th></tr>
			</thead>
			<tbody>
				{#each envRows(keys) as row (row.key)}
					<tr>
						<td class="name">
							<span class="t-ui">{ENV_LABELS[row.key] ?? row.key}</span>
							<span class="t-mono t-caption">{row.key}</span>
						</td>
						<td class="t-mono value">{envOnlyText(row)}</td>
						<td class="t-ui t-muted">{row.source === 'env' ? 'Environment' : 'Default'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/snippet}

{#snippet saveBar(section: SectionId)}
	<div class="savebar">
		<button
			type="submit"
			class="fp-btn fp-btn--primary"
			disabled={locked || busy !== null || dirtyKeys(section).length === 0}
		>
			{busy === section
				? 'Saving…'
				: section === 'monitoring' && retention && retention.rows > 0
					? 'Save and delete older data'
					: 'Save'}
		</button>
		<div class="savebar__msg" aria-live="polite">
			{#if done?.section === section}<span class="t-ui ok">{done.text}</span>{/if}
		</div>
	</div>
	{#if failed?.section === section}
		<Notice kind="error">{failed.text}</Notice>
	{/if}
{/snippet}

<PageHero
	kicker="System"
	title="Settings"
	lede="Change how this UI probes, keeps data and shows times, without a restart. Everything else is set in the environment and shown here with a check."
/>

{#if locked}
	<Notice>
		Saving is off while CADDY_UI_SETTINGS_IGNORE is on. “Use the environment’s value” still works and removes
		a saved value for good, which is how a bad one is cleared.
	</Notice>
{/if}

{#if view.warnings.length > 0 && !locked}
	<Notice kind="warning">
		<b>{view.warnings.length === 1 ? 'A saved setting is' : 'Some saved settings are'} not in use.</b>
		<ul class="warnings">
			{#each view.warnings as w (w.key)}<li><span class="t-mono">{w.key}</span>: {w.message}</li>{/each}
		</ul>
	</Notice>
{/if}

<nav class="fp-chips jump" aria-label="Sections">
	{#each NAV as s (s.id)}<a class="fp-chip" href="#{s.id}">{s.label}</a>{/each}
</nav>

<!-- Diagnostics -->
<section class="fp-section" id="diagnostics" aria-labelledby="diagnostics-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="diagnostics-h">Diagnostics</h2></div>
	<DiagnosticsPanel timeZone={data.timeZone} />
</section>

<!-- Monitoring -->
<section class="fp-section" id="monitoring" aria-labelledby="monitoring-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="monitoring-h">Monitoring</h2></div>
	<form
		class="fp-panel fields"
		onsubmit={(e) => {
			e.preventDefault();
			save('monitoring');
		}}
	>
		{#each SECTION_KEYS.monitoring as key (key)}
			<SettingField
				row={rowOf(key)}
				bind:value={() => valueOf(key), (v) => (drafts = { ...drafts, [key]: v })}
				error={errors[key]}
				{locked}
				busy={busy !== null}
				onreset={() => reset(key)}
			/>
		{/each}
		{#if retention}
			<div class="full">
				<Notice kind="warning">
					{#if retention.rows === 0 && retention.known}
						Nothing is older than {formatDate(retention.cutoff, data.timeZone)} yet, so nothing is deleted now.
					{:else}
						Saving deletes probe results and metrics from before
						<b>{formatDateTime(retention.cutoff, data.timeZone)}</b> at the next hourly clean-up{#if retention.known}:
							about <b>{formatNumber(retention.rows)}</b> rows, {formatBytes(retention.bytes)}{/if}. The
						database file keeps its size; the space is reused for new data.
					{/if}
				</Notice>
			</div>
		{/if}
		<div class="full">{@render saveBar('monitoring')}</div>
	</form>

	<div class="fp-section__head">
		<h3 class="t-title-3" id="probes-h">Per-site probes</h3>
	</div>
	<ProbeOptionsTable rows={data.probeOptions} />
</section>

<!-- Data and storage -->
<section class="fp-section" id="storage" aria-labelledby="storage-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="storage-h">Data and storage</h2></div>
	<div class="fp-section__head">
		<h3 class="t-title-3" id="dbsize-h">Database size</h3>
	</div>
	<div class="fp-tiles">
		<StatTile
			label="Database"
			value={formatBytes(dbTotal)}
			note={data.storage.walBytes > 0
				? `${formatBytes(data.storage.walBytes)} of it in the write-ahead log`
				: undefined}
		/>
		<StatTile
			label="Free on the volume"
			value={data.storage.volumeFreeBytes === null ? 'unknown' : formatBytes(data.storage.volumeFreeBytes)}
			note={data.storage.volumeTotalBytes ? `of ${formatBytes(data.storage.volumeTotalBytes)}` : undefined}
		/>
		<StatTile
			label="Oldest probe result"
			value={data.storage.oldest.probes ? formatDate(data.storage.oldest.probes, data.timeZone) : 'none yet'}
			note="Kept for {rowOf('CADDY_UI_RETENTION_DAYS').value} days"
		/>
		<StatTile
			label="Free inside the file"
			value={formatBytes(data.storage.freeInFileBytes)}
			note="Reused for new rows"
		/>
	</div>

	{#await data.tables}
		<div class="fp-panel" aria-busy="true">
			<p class="t-ui t-muted">Measuring each table. This reads the whole database in the background…</p>
			<span class="fp-skel skel"></span>
			<span class="fp-skel skel"></span>
			<span class="fp-skel skel"></span>
		</div>
	{:then m}
		{#if m.error}
			<Notice kind="warning">Table sizes could not be measured: {m.error}</Notice>
		{:else}
			<div class="fp-panel fp-table__wrap">
				<table class="fp-table">
					<caption class="visually-hidden">Size of each table in the database, with its indexes</caption>
					<thead>
						<tr>
							<th scope="col">Table</th>
							<th scope="col" class="num">Rows</th>
							<th scope="col" class="num">Size</th>
							<th scope="col" class="num share">Share</th>
						</tr>
					</thead>
					<tbody>
						{#each m.tables.filter((t) => t.bytes > 0) as t (t.name)}
							<tr>
								<td class="name">
									<span class="t-ui">{tableLabel(t.name)}</span>
									<span class="t-mono t-caption">{t.name}</span>
								</td>
								<td class="t-mono num">{formatNumber(t.rows)}</td>
								<td class="t-mono num">{formatBytes(t.bytes)}</td>
								<td class="t-mono num share"
									>{dbTotal > 0 ? `${Math.round((t.bytes / dbTotal) * 100)}%` : ''}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		<form
			method="POST"
			action="?/measure"
			class="measured t-ui t-muted"
			use:enhance={() => {
				measuring = true;
				return async ({ update }) => {
					await update();
					measuring = false;
				};
			}}
		>
			<span>Measured <AsOf at={m.at} timeZone={data.timeZone} />, in {formatMs(m.tookMs)}.</span>
			<button type="submit" class="fp-btn fp-btn--quiet" disabled={measuring}>
				{measuring ? 'Measuring…' : 'Measure again'}
			</button>
		</form>
	{/await}

	<div class="fp-section__head">
		<h3 class="t-title-3" id="tools-h">Tools</h3>
	</div>
	<StorageTools
		jobs={data.maintenance}
		timeZone={data.timeZone}
		retentionDays={rowOf('CADDY_UI_RETENTION_DAYS').value}
		dbBytes={dbTotal}
		freeInFileBytes={data.storage.freeInFileBytes}
		volumeFreeBytes={data.storage.volumeFreeBytes}
	/>

	<div class="fp-section__head">
		<h3 class="t-title-3" id="history-h">Caddyfile history</h3>
	</div>
	<form
		class="fp-panel fields"
		onsubmit={(e) => {
			e.preventDefault();
			save('storage');
		}}
	>
		{#each SECTION_KEYS.storage as key (key)}
			<SettingField
				row={rowOf(key)}
				bind:value={() => valueOf(key), (v) => (drafts = { ...drafts, [key]: v })}
				error={errors[key]}
				{locked}
				busy={busy !== null}
				onreset={() => reset(key)}
			/>
		{/each}
		{#if data.history}
			<p class="full t-ui t-muted">
				Kept now: {formatNumber(data.history.revisions)}
				{data.history.revisions === 1 ? 'revision' : 'revisions'} in
				<a class="inline-link" href="/history">History</a>
				and {formatNumber(data.history.backups)} backup {data.history.backups === 1 ? 'file' : 'files'}.
			</p>
		{/if}
		<div class="full">{@render saveBar('storage')}</div>
	</form>
</section>

<!-- Caddy helpers -->
<section class="fp-section" id="helpers" aria-labelledby="helpers-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="helpers-h">Caddy helpers</h2></div>
	<p class="t-body t-muted">
		One-click changes to the Caddyfile that turn on what the charts need. Each is shown as a change to review;
		Caddy checks it before it is saved, and the previous file stays in History.
	</p>
	<CaddyHelpers metrics={data.helpers.metrics} accessLog={data.helpers.accessLog} />
</section>

<!-- Display -->
<section class="fp-section" id="display" aria-labelledby="display-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="display-h">Display</h2></div>
	<form
		class="fp-panel fields"
		onsubmit={(e) => {
			e.preventDefault();
			save('display');
		}}
	>
		{#each SECTION_KEYS.display as key (key)}
			<SettingField
				row={rowOf(key)}
				bind:value={() => valueOf(key), (v) => (drafts = { ...drafts, [key]: v })}
				error={errors[key]}
				{locked}
				busy={busy !== null}
				timeZones={key === 'TZ' ? timeZones : []}
				onreset={() => reset(key)}
			/>
		{/each}
		<div class="full">{@render saveBar('display')}</div>
	</form>
</section>

<!-- Preferences (S6) -->
<section class="fp-section" id="preferences" aria-labelledby="preferences-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="preferences-h">Preferences</h2></div>
	<form class="fp-panel fields" method="POST" action="?/prefs" use:enhance>
		{#each prefFields as f (f.key)}
			<div class="setting">
				<label class="t-ui" for="pref-{f.key}">{f.label}</label>
				<span class="fp-select">
					<select id="pref-{f.key}" name={f.key} aria-describedby="pref-{f.key}-hint">
						{#each f.choices as [value, label] (value)}
							<option {value} selected={shown[f.key] === value}>{label}</option>
						{/each}
					</select>
					<ChevronDown class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
				</span>
				<p class="t-caption" id="pref-{f.key}-hint">{f.hint}</p>
			</div>
		{/each}
		<div class="full">
			<div class="savebar">
				<button type="submit" class="fp-btn fp-btn--primary">Save preferences</button>
				<div class="savebar__msg" aria-live="polite">
					{#if form?.prefsSaved}<span class="t-ui ok">Saved. It applies now.</span>{/if}
				</div>
			</div>
			{#if form?.prefsError}<Notice kind="error">{form.prefsError}</Notice>{/if}
		</div>
	</form>
	{#if overridden}
		<form class="override" method="POST" action="?/clearOverrides" use:enhance>
			<p class="t-caption">
				This browser keeps its own {overrideNames}, set with the buttons in the page. It does not follow the
				saved default.
			</p>
			<button type="submit" class="fp-btn">Use the saved default here</button>
		</form>
	{/if}
	{#if form?.overridesCleared}
		<p class="t-ui ok override" aria-live="polite">Done. This browser follows the saved defaults.</p>
	{/if}
</section>

<!-- Domains -->
<section class="fp-section" id="domains" aria-labelledby="domains-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="domains-h">Domains</h2></div>
	<form
		class="fp-panel fields"
		onsubmit={(e) => {
			e.preventDefault();
			save('domains');
		}}
	>
		{#each SECTION_KEYS.domains as key (key)}
			<SettingField
				row={rowOf(key)}
				bind:value={() => valueOf(key), (v) => (drafts = { ...drafts, [key]: v })}
				error={errors[key]}
				{locked}
				signIn={view.signIn}
				busy={busy !== null}
				onreset={() => reset(key)}
			/>
		{/each}
		<div class="full">{@render saveBar('domains')}</div>
	</form>

	{@render envTable('Porkbun settings set in the environment', [
		'PORKBUN_API_KEY',
		'PORKBUN_API_SECRET_KEY',
		'PORKBUN_API_URL',
		'CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD'
	])}
	<p class="t-caption">
		The keys are set in the environment only, where Caddy reads the same pair for its DNS challenge. This page
		never shows them.
	</p>
	<div class="test">
		<button type="button" class="fp-btn" disabled={!keysSet || porkbunTest.busy} onclick={testPorkbun}>
			{porkbunTest.busy ? 'Testing…' : 'Test connection'}
		</button>
		<div class="test__out t-ui" aria-live="polite">
			{#if !keysSet}
				<span class="t-muted">Set both keys to use the Domains area.</span>
			{:else if porkbunTest.error}
				<Tag kind="error">Failed</Tag> {porkbunTest.error}
			{:else if porkbunTest.result}
				{@const r = porkbunTest.result}
				{#if r.state === 'ok'}
					<Tag kind="success">Connected</Tag>
					{r.account ? `Account ${r.account}.` : ''}
					{r.scopes.length ? `The key may use ${r.scopes.join(', ')}.` : ''}
					{r.sandbox ? 'Sandbox key: nothing real is changed.' : ''}
				{:else}
					<Tag kind="error">{r.state === 'misconfigured' ? 'Not set up' : 'Failed'}</Tag>
					{r.error?.message ?? (r.missing ? `${r.missing} is not set.` : 'Porkbun did not accept the keys.')}
				{/if}
			{/if}
		</div>
	</div>
</section>

<!-- Connections -->
<section class="fp-section" id="connections" aria-labelledby="connections-h">
	<div class="fp-section__head">
		<h2 class="t-title-2" id="connections-h">Connections</h2>
		<button type="button" class="fp-btn fp-btn--quiet" onclick={recheck} disabled={checking}>
			{checking ? 'Checking…' : 'Check again'}
		</button>
	</div>
	<p class="t-body t-muted">
		These name the container's wiring and mounts, so they change in compose, followed by a restart.
	</p>
	<div class="fp-panel fp-table__wrap">
		<table class="fp-table">
			<caption class="visually-hidden">Caddy admin API and paths, with checks</caption>
			<thead>
				<tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Check</th></tr>
			</thead>
			<tbody>
				<tr>
					<td class="name">
						<span class="t-ui">{ENV_LABELS.CADDY_ADMIN_URL}</span>
						<span class="t-mono t-caption">CADDY_ADMIN_URL</span>
					</td>
					<td class="t-mono value">{envOnly(view, 'CADDY_ADMIN_URL')?.value}</td>
					<td
						><div class="check__in">
							<button type="button" class="fp-btn" onclick={testAdmin} disabled={adminTest.busy}>
								{adminTest.busy ? 'Testing…' : 'Test'}
							</button>
							<span class="t-ui" aria-live="polite">
								{#if adminTest.error}
									<Tag kind="error">Failed</Tag> {adminTest.error}
								{:else if adminTest.result}
									{#if adminTest.result.reachable && !adminTest.result.error}
										<Tag kind="success">Reachable</Tag>
										{adminTest.result.version ? `Caddy ${adminTest.result.version}.` : ''}
									{:else}
										<Tag kind="error">{adminTest.result.reachable ? 'Error' : 'Not reachable'}</Tag>
										{adminTest.result.error ?? ''}
									{/if}
								{/if}
							</span>
						</div></td
					>
				</tr>
				{#each data.paths as p (p.key)}
					<tr>
						<td class="name">
							<span class="t-ui">{ENV_LABELS[p.key]}</span>
							<span class="t-mono t-caption">{p.key}</span>
						</td>
						<td class="t-mono value">{p.path}</td>
						<td
							><div class="check__in">
								<Tag kind={pathState[p.state]}>{pathTag[p.state]}</Tag>
								<span class="t-ui">{p.message}</span>
							</div></td
						>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{@render envTable('The listener, set in the environment', ['CADDY_UI_PORT', 'PORT', 'HOST', 'ORIGIN'])}
</section>

<!-- Sign-in -->
<section class="fp-section" id="sign-in" aria-labelledby="sign-in-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="sign-in-h">Sign-in</h2></div>
	<p class="t-body t-muted">
		Sign-in is set in the environment only, so nobody who reaches this page can turn it off. In use:
		<b>{AUTH_TEXT[data.authMode] ?? data.authMode}</b>.
	</p>
	{@render envTable('Sign-in settings, set in the environment', [
		'CADDY_UI_AUTH_MODE',
		'CADDY_UI_USER',
		'CADDY_UI_PASSWORD',
		'CADDY_UI_SESSION_SECRET'
	])}
	{#if !envOnly(view, 'CADDY_UI_SESSION_SECRET')?.set && data.authMode === 'local'}
		<p class="t-caption">
			Without CADDY_UI_SESSION_SECRET a new one is made at each start, which signs everyone out.
		</p>
	{/if}
</section>

<!-- Updates -->
<section class="fp-section" id="updates" aria-labelledby="updates-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="updates-h">Updates</h2></div>
	<p class="t-body t-muted">
		The updater is a separate container that keeps this one current. This page talks to it through two small
		files in a shared folder: it never touches Docker itself.
	</p>

	{#if notice}
		<Notice kind={notice.kind === 'warning' ? 'warning' : undefined}>{notice.text}</Notice>
	{/if}

	<div class="fp-panel fp-table__wrap">
		<table class="fp-table">
			<caption class="visually-hidden">The running version and the updater's last check</caption>
			<tbody>
				<tr>
					<th scope="row" class="t-ui">Running version</th>
					<td class="t-mono" data-testid="update-current">{updates.version}</td>
				</tr>
				<tr>
					<th scope="row" class="t-ui">Newest found</th>
					<td class="t-mono" data-testid="update-latest">
						{updates.status?.latest?.version || (updates.status ? 'not reported yet' : 'unknown')}
					</td>
				</tr>
				<tr>
					<th scope="row" class="t-ui">Last check</th>
					<td data-testid="update-last">
						{#if updates.status?.lastRun}
							{@const run = updates.status.lastRun}
							<div class="check__in">
								<Tag kind={RESULT_TAG[run.result].kind}>{RESULT_TAG[run.result].text}</Tag>
								<span class="t-ui">
									{formatDateTime(Date.parse(run.finishedAt), data.timeZone)}, {TRIGGER_TEXT[run.trigger]}
								</span>
							</div>
							{#if run.message}<p class="t-caption">{run.message}</p>{/if}
						{:else if updates.status?.checking}
							<span class="t-ui">Checking now…</span>
						{:else}
							<span class="t-ui t-muted">No check yet.</span>
						{/if}
					</td>
				</tr>
				<tr>
					<th scope="row" class="t-ui">Next check</th>
					<td class="t-ui" data-testid="update-next">
						{#if updates.status?.checking}
							Running now
						{:else if updates.status?.nextCheckAt}
							{formatDateTime(Date.parse(updates.status.nextCheckAt), data.timeZone)}
						{:else}
							<span class="t-muted">Unknown</span>
						{/if}
					</td>
				</tr>
				<tr>
					<th scope="row" class="t-ui">Updater uses</th>
					<td class="t-ui" data-testid="update-using">
						{#if updates.status}
							Every {intervalText(updates.status.intervalSeconds)}
							<span class="t-muted">
								({updates.status.intervalFrom === 'control' ? 'set here' : 'from its own environment'}), from {updates
									.status.source === 'git'
									? 'a git build'
									: 'the container registry'}
							</span>
						{:else}
							<span class="t-muted">Unknown</span>
						{/if}
					</td>
				</tr>
			</tbody>
		</table>
	</div>
	{#if updates.status?.warning}
		<Notice kind="warning">The updater says: {updates.status.warning}.</Notice>
	{/if}

	<div class="test">
		<form
			method="POST"
			action="?/checkNow"
			use:enhance={() => {
				checkError = null;
				checkSent = true;
				return async ({ result, update }) => {
					if (result.type === 'failure') {
						checkError = String(result.data?.checkError ?? 'The request could not be sent.');
						checkSent = false;
					}
					await update({ reset: false });
				};
			}}
		>
			<button type="submit" class="fp-btn" disabled={updates.state === 'no-channel' || busyChecking}>
				{busyChecking ? 'Checking…' : 'Check now'}
			</button>
		</form>
		<div class="test__out t-ui" aria-live="polite">
			{#if checkError}
				<Tag kind="error">Failed</Tag> {checkError}
			{:else if updates.checkPending}
				Asked. The updater picks it up within {updates.status?.pollSeconds ?? 5} seconds.
			{/if}
		</div>
	</div>

	<form
		class="fp-panel fields"
		onsubmit={(e) => {
			e.preventDefault();
			save('updates');
		}}
	>
		{#each SECTION_KEYS.updates as key (key)}
			<SettingField
				row={rowOf(key)}
				bind:value={() => valueOf(key), (v) => (drafts = { ...drafts, [key]: v })}
				error={errors[key]}
				{locked}
				signIn={view.signIn}
				busy={busy !== null}
				onreset={() => reset(key)}
			/>
		{/each}
		<div class="full">{@render saveBar('updates')}</div>
	</form>

	{@render envTable('Updater settings, set in the environment', [
		'CADDY_UI_UPDATE_SOURCE',
		'CADDY_UI_UPDATE_WEBHOOK_PORT',
		'CADDY_UI_UPDATER_DIR',
		'CADDY_UI_SETTINGS_IGNORE'
	])}
	<p class="t-caption">
		The source, the webhook and the shared folder are set in compose, where the updater reads them too. The
		folder is <span class="t-mono">{updates.dir}</span>.
	</p>
</section>

<!-- Recent changes -->
<section class="fp-section" id="changes" aria-labelledby="changes-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="changes-h">Recent changes</h2></div>
	{#if view.log.length === 0}
		<EmptyState title="No changes yet" line="Every value saved or reset here is listed, with who and when." />
	{:else}
		<div class="fp-panel fp-table__wrap">
			<table class="fp-table">
				<caption class="visually-hidden"
					>The latest {view.log.length} changes to settings, newest first</caption
				>
				<thead>
					<tr>
						<th scope="col">When</th>
						<th scope="col">Who</th>
						<th scope="col">Setting</th>
						<th scope="col">Change</th>
					</tr>
				</thead>
				<tbody>
					{#each view.log as entry (entry.id)}
						<tr>
							<td class="t-ui when">{formatDateTime(entry.ts, data.timeZone)}</td>
							<td class="t-ui">{entry.author}</td>
							<td class="name">
								{#if entry.key.startsWith('probe:')}
									<span class="t-ui">Probe options</span>
									<span class="t-mono t-caption">{entry.key.slice('probe:'.length)}</span>
								{:else}
									<span class="t-ui">{FIELDS[entry.key]?.label ?? entry.key}</span>
									<span class="t-mono t-caption">{entry.key}</span>
								{/if}
							</td>
							<td class="t-mono value">
								{logText(entry.oldValue)} → {logText(entry.newValue)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.setting {
		display: grid;
		gap: var(--space-2);
		align-content: start;
	}
	.override {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
		margin-top: var(--space-4);
	}
	.jump {
		margin-top: calc(var(--space-2) * -1);
	}
	.fp-section {
		scroll-margin-top: var(--space-8);
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
		gap: var(--space-6) var(--space-5);
		align-items: start;
	}
	.full {
		grid-column: 1 / -1;
	}
	.savebar {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-wrap: wrap;
	}
	.ok {
		color: var(--success-ink);
	}
	.name {
		min-width: 10rem;
	}
	.name > span {
		display: block;
	}
	.value {
		overflow-wrap: anywhere;
	}
	.num {
		text-align: right;
		white-space: nowrap;
	}
	.when {
		white-space: nowrap;
	}
	@media (max-width: 640px) {
		.share {
			display: none;
		}
	}
	.check__in {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.test {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.test__out {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.measured {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.skel {
		height: 20px;
		margin-top: var(--space-3);
	}
	.inline-link {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.warnings {
		margin: var(--space-1) 0 0;
		padding-left: var(--space-5);
	}
</style>
