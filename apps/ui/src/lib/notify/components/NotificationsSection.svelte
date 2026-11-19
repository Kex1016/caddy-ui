<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { EmptyState, Notice, Tag } from '$lib/design/components';
	import { formatDateTime } from '$lib/format';
	import MessagePreview from './MessagePreview.svelte';
	import {
		COMMON_PLACEHOLDERS,
		EVENT_HINTS,
		EVENT_LABELS,
		PLACEHOLDERS,
		PLACEHOLDER_HINTS,
		buildComponents,
		checkTemplate,
		defaultRaw,
		defaultTemplate,
		embedPayload,
		sameTemplate,
		sampleVars
	} from '../templates';
	import {
		EVENTS,
		type EventKind,
		type EventTemplate,
		type NotifyError,
		type NotifyPatch,
		type NotifyTestResult,
		type NotifyView
	} from '../types';

	/**
	 * Settings → Notifications (docs/settings-and-perf-plan.md §3.1): the webhook (write-only), the thresholds, an
	 * on/off switch per event, and per event a message editor with placeholders, a live preview, "Send test",
	 * "Reset to default" and the raw Components v2 JSON behind an advanced switch.
	 */
	type Props = { view: NotifyView };
	let { view }: Props = $props();

	const tz = $derived(view.timeZone);
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	async function put(body: NotifyPatch): Promise<NotifyError | null> {
		try {
			const res = await fetch('/api/notifications', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (res.ok) {
				await invalidateAll();
				return null;
			}
			return (
				((await res.json().catch(() => null)) as NotifyError | null) ?? {
					message: `The UI answered ${res.status}.`,
					code: 'INVALID'
				}
			);
		} catch {
			return { message: 'This UI could not be reached.', code: 'INVALID' };
		}
	}

	// ── webhook ────────────────────────────────────────────────────────────────────────────────
	let webhook = $state('');
	let hookBusy = $state(false);
	let hookError = $state<string | null>(null);
	let hookDone = $state<string | null>(null);

	async function saveWebhook(value: string | null) {
		hookBusy = true;
		hookError = null;
		hookDone = null;
		const err = await put({ webhook: value });
		hookBusy = false;
		if (err) hookError = err.errors?.webhook ?? err.message;
		else {
			webhook = '';
			hookDone =
				value === null
					? 'Removed. Nothing is sent until a new one is saved.'
					: 'Saved. It is not shown again.';
		}
	}

	let retryBusy = $state(false);
	async function retryComponents() {
		retryBusy = true;
		await put({ retryComponents: true });
		retryBusy = false;
	}

	// ── thresholds ─────────────────────────────────────────────────────────────────────────────
	let cycles = $state<string | null>(null);
	let flap = $state<string | null>(null);
	const cyclesValue = $derived(cycles ?? String(view.config.downCycles));
	const flapValue = $derived(flap ?? String(view.config.flapMinutes));
	const thresholdsDirty = $derived(
		(cycles !== null && cycles.trim() !== String(view.config.downCycles)) ||
			(flap !== null && flap.trim() !== String(view.config.flapMinutes))
	);
	let thrBusy = $state(false);
	let thrErrors = $state<Record<string, string>>({});
	let thrDone = $state(false);

	async function saveThresholds(e: SubmitEvent) {
		e.preventDefault();
		thrBusy = true;
		thrDone = false;
		thrErrors = {};
		const err = await put({ downCycles: Number(cyclesValue.trim()), flapMinutes: Number(flapValue.trim()) });
		thrBusy = false;
		if (err) thrErrors = err.errors ?? { downCycles: err.message };
		else {
			cycles = null;
			flap = null;
			thrDone = true;
		}
	}

	// ── events ─────────────────────────────────────────────────────────────────────────────────
	let toggling = $state<EventKind | null>(null);
	let toggleError = $state<{ kind: EventKind; text: string } | null>(null);

	async function toggle(kind: EventKind, enabled: boolean) {
		toggling = kind;
		toggleError = null;
		const err = await put({ events: { [kind]: { ...view.config.events[kind], enabled } } });
		if (err) toggleError = { kind, text: err.message };
		if (editing === kind && draft) draft = { ...draft, enabled };
		toggling = null;
	}

	let editing = $state<EventKind | null>(null);
	let draft = $state<EventTemplate | null>(null);
	let fieldErrors = $state<Record<string, string>>({});
	let saving = $state(false);
	let saved = $state(false);
	let test = $state<{ busy: boolean; result: NotifyTestResult | null; error: string | null }>({
		busy: false,
		result: null,
		error: null
	});

	function edit(kind: EventKind) {
		if (editing === kind) {
			editing = null;
			draft = null;
			return;
		}
		editing = kind;
		draft = { ...view.config.events[kind] };
		fieldErrors = {};
		saved = false;
		test = { busy: false, result: null, error: null };
	}

	const dirty = $derived(!!(editing && draft && !sameTemplate(draft, view.config.events[editing])));
	const atDefault = $derived(!!(editing && draft && sameTemplate(draft, defaultTemplate(editing))));
	const liveErrors = $derived(draft ? checkTemplate(draft) : {});
	const errorOf = (field: string) => fieldErrors[field] ?? liveErrors[field];

	function serverErrors(kind: EventKind, err: NotifyError) {
		const out: Record<string, string> = {};
		const prefix = `events.${kind}.`;
		for (const [k, v] of Object.entries(err.errors ?? {}))
			if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
		return out;
	}

	async function saveEvent(e: SubmitEvent) {
		e.preventDefault();
		if (!editing || !draft) return;
		saving = true;
		saved = false;
		const kind = editing;
		const err = await put({ events: { [kind]: draft } });
		saving = false;
		if (err) {
			fieldErrors = serverErrors(kind, err);
			if (Object.keys(fieldErrors).length === 0) fieldErrors = { body: err.message };
		} else {
			fieldErrors = {};
			saved = true;
			draft = { ...view.config.events[kind] };
		}
	}

	function resetEvent() {
		if (!editing) return;
		draft = { ...defaultTemplate(editing), enabled: draft?.enabled ?? defaultTemplate(editing).enabled };
		fieldErrors = {};
		saved = false;
	}

	async function sendTest() {
		if (!editing || !draft) return;
		test = { busy: true, result: null, error: null };
		try {
			const res = await fetch('/api/notifications/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ event: editing, template: draft, ...(webhook.trim() ? { webhook } : {}) })
			});
			const body = (await res.json().catch(() => null)) as (NotifyTestResult & NotifyError) | null;
			if (!res.ok)
				test = { busy: false, result: null, error: body?.message ?? `The UI answered ${res.status}.` };
			else test = { busy: false, result: body, error: null };
			await invalidateAll();
		} catch {
			test = { busy: false, result: null, error: 'This UI could not be reached.' };
		}
	}

	function setAdvanced(on: boolean) {
		if (!editing || !draft) return;
		draft = {
			...draft,
			advanced: on,
			raw: on && draft.raw === null ? defaultRaw(editing, draft) : draft.raw
		};
	}

	// Placeholders go in at the cursor of the field last typed in.
	let lastField = $state<'heading' | 'body' | 'raw'>('body');
	const inputs: Partial<Record<'heading' | 'body' | 'raw', HTMLInputElement | HTMLTextAreaElement>> = {};
	function insert(name: string) {
		if (!draft) return;
		const field = draft.advanced ? 'raw' : lastField === 'raw' ? 'body' : lastField;
		const el = inputs[field];
		const cur = (field === 'raw' ? draft.raw : draft[field]) ?? '';
		const at = el?.selectionStart ?? cur.length;
		const end = el?.selectionEnd ?? at;
		const next = `${cur.slice(0, at)}{${name}}${cur.slice(end)}`;
		draft = { ...draft, [field]: next };
		requestAnimationFrame(() => {
			el?.focus();
			el?.setSelectionRange(at + name.length + 2, at + name.length + 2);
		});
	}

	const preview = $derived.by(() => {
		if (!editing || !draft) return null;
		if (draft.advanced && liveErrors.raw) return { error: liveErrors.raw };
		const vars = sampleVars(editing, { now, publicUrl: view.publicUrl, timeZone: tz });
		try {
			if (view.webhook.embedSince) return { embed: embedPayload(editing, draft, vars, now) };
			return { components: buildComponents(editing, draft, vars) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	});

	const hookId = $derived(view.webhook.id ? `…${view.webhook.id.slice(-4)}` : '');
</script>

<section class="fp-section" id="notifications" aria-labelledby="notifications-h">
	<div class="fp-section__head"><h2 class="t-title-2" id="notifications-h">Notifications</h2></div>
	<p class="t-body t-muted">
		Discord messages when a site goes down or comes back, a certificate nears its end, the Caddyfile changes
		outside this UI, or an update is applied. They are sent from the server, so they work with no browser
		open.
	</p>

	<!-- Webhook -->
	<form
		class="fp-panel hook"
		onsubmit={(e) => {
			e.preventDefault();
			saveWebhook(webhook);
		}}
	>
		<div class="hook__head">
			<label class="t-ui label" for="notify-webhook">Discord webhook</label>
			{#if view.webhook.set}
				<Tag kind="success">Saved · webhook {hookId}</Tag>
			{:else}
				<Tag>Not set</Tag>
			{/if}
		</div>
		<div class="hook__row">
			<span class="fp-field hook__field">
				<input
					id="notify-webhook"
					type="password"
					autocomplete="off"
					spellcheck="false"
					placeholder={view.webhook.set
						? 'Paste a new URL to replace the saved one'
						: 'https://discord.com/api/webhooks/…'}
					bind:value={webhook}
					aria-describedby="notify-webhook-hint{hookError ? ' notify-webhook-err' : ''}"
					aria-invalid={hookError ? 'true' : undefined}
				/>
			</span>
			<button type="submit" class="fp-btn fp-btn--primary" disabled={hookBusy || webhook.trim() === ''}>
				{hookBusy ? 'Saving…' : 'Save webhook'}
			</button>
			{#if view.webhook.set}
				<button
					type="button"
					class="fp-btn fp-btn--quiet"
					disabled={hookBusy}
					onclick={() => saveWebhook(null)}
				>
					Remove
				</button>
			{/if}
		</div>
		<p class="t-caption hint" id="notify-webhook-hint">
			In Discord: the channel’s settings, Integrations, Webhooks, New Webhook, Copy Webhook URL. The URL works
			like a password for the channel, so after saving it is never shown again and exports leave it out.
		</p>
		{#if hookError}<p class="t-caption err" id="notify-webhook-err">{hookError}</p>{/if}
		{#if hookDone}<p class="t-ui ok" aria-live="polite">{hookDone}</p>{/if}
		{#if view.webhook.embedSince}
			<Notice kind="warning">
				This webhook refused a Components v2 message on {formatDateTime(view.webhook.embedSince, tz)}, so
				messages go as classic embeds with the same text, colour and link.
				<button type="button" class="fp-btn fp-btn--quiet" disabled={retryBusy} onclick={retryComponents}>
					{retryBusy ? 'Saving…' : 'Try Components v2 again'}
				</button>
			</Notice>
		{/if}
	</form>

	<!-- Thresholds -->
	<form class="fp-panel thresholds" onsubmit={saveThresholds}>
		<div class="num">
			<label class="t-ui label" for="notify-cycles">Down after</label>
			<div class="num__row">
				<span class="fp-field num__field">
					<input
						id="notify-cycles"
						inputmode="numeric"
						value={cyclesValue}
						oninput={(e) => (cycles = e.currentTarget.value)}
						aria-describedby="notify-cycles-hint"
						aria-invalid={thrErrors.downCycles ? 'true' : undefined}
					/>
				</span>
				<span class="t-ui">failed checks in a row</span>
			</div>
			<p class="t-caption hint" id="notify-cycles-hint">
				One probe cycle is the probe interval (Monitoring). 1 to 20; the default 2 rides out a single hiccup.
			</p>
			{#if thrErrors.downCycles}<p class="t-caption err">{thrErrors.downCycles}</p>{/if}
		</div>
		<div class="num">
			<label class="t-ui label" for="notify-flap">At most one message per site every</label>
			<div class="num__row">
				<span class="fp-field num__field">
					<input
						id="notify-flap"
						inputmode="numeric"
						value={flapValue}
						oninput={(e) => (flap = e.currentTarget.value)}
						aria-describedby="notify-flap-hint"
						aria-invalid={thrErrors.flapMinutes ? 'true' : undefined}
					/>
				</span>
				<span class="t-ui">minutes</span>
			</div>
			<p class="t-caption hint" id="notify-flap-hint">
				A site that keeps flipping gets one message, and its last state once the minutes are up. 0 turns this
				off.
			</p>
			{#if thrErrors.flapMinutes}<p class="t-caption err">{thrErrors.flapMinutes}</p>{/if}
		</div>
		<div class="full savebar">
			<button type="submit" class="fp-btn fp-btn--primary" disabled={thrBusy || !thresholdsDirty}>
				{thrBusy ? 'Saving…' : 'Save'}
			</button>
			{#if thrDone}<span class="t-ui ok" aria-live="polite">Saved. It applies from the next probe cycle.</span
				>{/if}
		</div>
	</form>

	<!-- Events -->
	<h3 class="t-title-3">Events</h3>
	{#if !view.webhook.set}
		<p class="t-caption">
			Save a webhook to send anything. The switches and messages can be set up before that.
		</p>
	{/if}
	<ul class="fp-panel events">
		{#each EVENTS as kind (kind)}
			{@const t = view.config.events[kind]}
			<li class="ev" class:ev--open={editing === kind}>
				<div class="ev__row">
					<label class="tgl" for="notify-on-{kind}">
						<input
							id="notify-on-{kind}"
							type="checkbox"
							role="switch"
							checked={t.enabled}
							disabled={toggling !== null}
							onchange={(e) => toggle(kind, e.currentTarget.checked)}
							aria-describedby="notify-hint-{kind}"
						/>
						<span class="tgl__track" aria-hidden="true"><span class="tgl__knob"></span></span>
						<span class="t-ui ev__label">{EVENT_LABELS[kind]}</span>
					</label>
					{#if view.customized.includes(kind)}<Tag kind="acc">Edited</Tag>{/if}
					<button
						type="button"
						class="fp-btn fp-btn--quiet ev__edit"
						aria-expanded={editing === kind}
						aria-controls="notify-editor-{kind}"
						onclick={() => edit(kind)}
					>
						{editing === kind ? 'Close' : 'Edit message'}
					</button>
				</div>
				<p class="t-caption hint ev__hint" id="notify-hint-{kind}">{EVENT_HINTS[kind]}</p>
				{#if toggleError?.kind === kind}<p class="t-caption err">{toggleError.text}</p>{/if}

				{#if editing === kind && draft}
					<div class="editor" id="notify-editor-{kind}">
						<form class="editor__form" onsubmit={saveEvent}>
							{#if !draft.advanced}
								<div class="fld">
									<label class="t-ui label" for="nt-heading">Heading</label>
									<span class="fp-field">
										<input
											id="nt-heading"
											bind:this={inputs.heading}
											value={draft.heading}
											oninput={(e) => draft && (draft = { ...draft, heading: e.currentTarget.value })}
											onfocus={() => (lastField = 'heading')}
											aria-invalid={errorOf('heading') ? 'true' : undefined}
										/>
									</span>
									{#if errorOf('heading')}<p class="t-caption err">{errorOf('heading')}</p>{/if}
								</div>
								<div class="fld">
									<label class="t-ui label" for="nt-body">Text</label>
									<textarea
										id="nt-body"
										class="area"
										rows="4"
										bind:this={inputs.body}
										value={draft.body}
										oninput={(e) => draft && (draft = { ...draft, body: e.currentTarget.value })}
										onfocus={() => (lastField = 'body')}
										aria-describedby="nt-body-hint"
										aria-invalid={errorOf('body') ? 'true' : undefined}
									></textarea>
									<p class="t-caption hint" id="nt-body-hint">
										Discord markdown works: **bold**, *italic*, `code`, [link](https://…), and a line starting
										with &gt; quotes it.
									</p>
									{#if errorOf('body')}<p class="t-caption err">{errorOf('body')}</p>{/if}
								</div>
							{:else}
								<div class="fld">
									<label class="t-ui label" for="nt-raw">Components v2 JSON</label>
									<textarea
										id="nt-raw"
										class="area t-mono"
										rows="16"
										wrap="off"
										spellcheck="false"
										bind:this={inputs.raw}
										value={draft.raw ?? ''}
										oninput={(e) => draft && (draft = { ...draft, raw: e.currentTarget.value })}
										onfocus={() => (lastField = 'raw')}
										aria-describedby="nt-raw-hint"
										aria-invalid={errorOf('raw') ? 'true' : undefined}
									></textarea>
									<p class="t-caption hint" id="nt-raw-hint">
										An array of components: container (17), text display (10), section (9), separator (14),
										thumbnail (11), media gallery (12), and action rows (1) of link buttons (2, style 5). A
										webhook can send nothing interactive. Placeholders work in any text or URL.
									</p>
									{#if errorOf('raw')}<p class="t-caption err">{errorOf('raw')}</p>{/if}
								</div>
							{/if}

							<div class="fld">
								<span class="t-ui label" id="nt-ph-label">Placeholders</span>
								<div class="chips" role="group" aria-labelledby="nt-ph-label">
									{#each [...PLACEHOLDERS[kind], ...COMMON_PLACEHOLDERS] as p (p)}
										<button
											type="button"
											class="fp-chip t-mono"
											title={PLACEHOLDER_HINTS[p]}
											onclick={() => insert(p)}>{`{${p}}`}</button
										>
									{/each}
								</div>
								<p class="t-caption hint">
									Click one to put it at the cursor. Values are filled in when sent.
								</p>
							</div>

							<div class="pair">
								{#if !draft.advanced}
									<div class="fld">
										<label class="t-ui label" for="nt-accent">Accent colour</label>
										<div class="colour">
											<input
												type="color"
												class="swatch"
												aria-label="Pick the accent colour"
												value={/^#[0-9a-f]{6}$/i.test(draft.accent) ? draft.accent : '#000000'}
												oninput={(e) => draft && (draft = { ...draft, accent: e.currentTarget.value })}
											/>
											<span class="fp-field colour__hex">
												<input
													id="nt-accent"
													class="t-mono"
													value={draft.accent}
													oninput={(e) => draft && (draft = { ...draft, accent: e.currentTarget.value })}
													aria-invalid={errorOf('accent') ? 'true' : undefined}
												/>
											</span>
										</div>
										{#if errorOf('accent')}<p class="t-caption err">{errorOf('accent')}</p>{/if}
									</div>
								{/if}
								<div class="fld">
									<label class="t-ui label" for="nt-mention">Mention</label>
									<span class="fp-field">
										<input
											id="nt-mention"
											class="t-mono"
											placeholder="<@&role id> or @here"
											value={draft.mention}
											oninput={(e) => draft && (draft = { ...draft, mention: e.currentTarget.value })}
											aria-describedby="nt-mention-hint"
											aria-invalid={errorOf('mention') ? 'true' : undefined}
										/>
									</span>
									<p class="t-caption hint" id="nt-mention-hint">
										Who gets pinged. With Developer Mode on in Discord, right-click a role or user to copy its
										id.
									</p>
									{#if errorOf('mention')}<p class="t-caption err">{errorOf('mention')}</p>{/if}
								</div>
							</div>

							{#if !draft.advanced}
								<label class="tgl" for="nt-button">
									<input
										id="nt-button"
										type="checkbox"
										role="switch"
										checked={draft.button}
										onchange={(e) => draft && (draft = { ...draft, button: e.currentTarget.checked })}
										aria-describedby="nt-button-hint"
									/>
									<span class="tgl__track" aria-hidden="true"><span class="tgl__knob"></span></span>
									<span class="t-ui">Link button to this UI</span>
								</label>
								<p class="t-caption hint tgl__hint" id="nt-button-hint">
									{view.publicUrl
										? `Opens ${view.publicUrl} at the right page.`
										: 'Needs a public address (Display, above); without one the button is left out.'}
								</p>
							{/if}

							<label class="tgl" for="nt-advanced">
								<input
									id="nt-advanced"
									type="checkbox"
									role="switch"
									checked={draft.advanced}
									onchange={(e) => setAdvanced(e.currentTarget.checked)}
									aria-describedby="nt-advanced-hint"
								/>
								<span class="tgl__track" aria-hidden="true"><span class="tgl__knob"></span></span>
								<span class="t-ui">Edit the raw JSON</span>
							</label>
							<p class="t-caption hint tgl__hint" id="nt-advanced-hint">
								For layouts the fields cannot make. Turning it off goes back to the fields, which are kept.
							</p>

							<div class="savebar">
								<button
									type="submit"
									class="fp-btn fp-btn--primary"
									disabled={saving || !dirty || Object.keys(liveErrors).length > 0}
								>
									{saving ? 'Saving…' : 'Save'}
								</button>
								<button
									type="button"
									class="fp-btn"
									disabled={test.busy ||
										(!view.webhook.set && webhook.trim() === '') ||
										Object.keys(liveErrors).length > 0}
									onclick={sendTest}
								>
									{test.busy ? 'Sending…' : 'Send test'}
								</button>
								<button type="button" class="fp-btn fp-btn--quiet" disabled={atDefault} onclick={resetEvent}>
									Reset to default
								</button>
								<span class="t-ui savebar__msg" aria-live="polite">
									{#if saved}<span class="ok">Saved.</span>{/if}
									{#if dirty && !saved}<span class="t-muted">Not saved yet.</span>{/if}
								</span>
							</div>
							<div class="t-ui test" aria-live="polite">
								{#if !view.webhook.set && webhook.trim() === ''}
									<span class="t-muted">Save a webhook, or paste one above, to send a test.</span>
								{:else if test.error}
									<Tag kind="error">Not sent</Tag> {test.error}
								{:else if test.result}
									{#if test.result.ok}
										<Tag kind="success">Sent</Tag>
										{test.result.fellBack
											? 'The webhook refused Components v2, so it went as an embed.'
											: test.result.format === 'embed'
												? 'Sent as an embed.'
												: 'Check the channel. It is marked as a test.'}
									{:else}
										<Tag kind="error">Not sent</Tag> {test.result.error}
									{/if}
								{/if}
							</div>
						</form>

						<div class="editor__preview">
							<span class="t-ui label">Preview, with sample values</span>
							{#if preview?.error}
								<Notice kind="error">The preview needs valid JSON: {preview.error}</Notice>
							{:else if preview}
								<MessagePreview components={preview.components} embed={preview.embed} timeZone={tz} {now} />
							{/if}
							{#if view.webhook.embedSince}
								<p class="t-caption">Shown as the embed this webhook gets.</p>
							{/if}
						</div>
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	<!-- Deliveries -->
	<h3 class="t-title-3">Recently sent</h3>
	{#if view.deliveries.length === 0}
		<EmptyState
			title="Nothing sent yet"
			line="Each message and test is listed here, with what Discord answered."
		/>
	{:else}
		<div class="fp-panel fp-table__wrap">
			<table class="fp-table">
				<caption class="visually-hidden">The latest notifications sent, newest first</caption>
				<thead>
					<tr>
						<th scope="col">When</th>
						<th scope="col">Event</th>
						<th scope="col">About</th>
						<th scope="col">Result</th>
					</tr>
				</thead>
				<tbody>
					{#each view.deliveries as d (d.id)}
						<tr>
							<td class="t-ui when">{formatDateTime(d.ts, tz)}</td>
							<td class="t-ui">{EVENT_LABELS[d.event]}{d.test ? ' (test)' : ''}</td>
							<td class="t-mono about">{d.subject}</td>
							<td class="t-ui">
								{#if d.ok}
									<Tag kind="success">Sent</Tag>
									{d.format === 'embed' ? 'as an embed' : ''}
								{:else}
									<Tag kind="error">Failed</Tag>
									<span class="about">{d.error}</span>
								{/if}
								{#if d.attempts > 1}<span class="t-muted"> · {d.attempts} tries</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.fp-section {
		scroll-margin-top: var(--space-8);
	}
	.label {
		font-weight: 500;
	}
	.hint {
		color: var(--muted);
		margin: 0;
	}
	.err {
		color: var(--error-ink);
		margin: 0;
	}
	.ok {
		color: var(--success-ink);
	}
	.hook {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.hook__head,
	.hook__row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.hook__field {
		flex: 1 1 20rem;
		min-width: 0;
	}
	.thresholds {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
		gap: var(--space-5);
		align-items: start;
	}
	.full {
		grid-column: 1 / -1;
	}
	.num {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.num__row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.num__field {
		width: 5rem;
	}
	.savebar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.events {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.ev {
		padding: var(--space-3) var(--space-4);
		border-top: 1px solid var(--line-soft);
	}
	.ev:first-child {
		border-top: 0;
	}
	.ev__row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}
	.ev__edit {
		margin-left: auto;
	}
	.ev__label {
		font-weight: 500;
	}
	.ev__hint {
		padding-left: calc(36px + var(--space-3));
	}
	.editor {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-5);
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		border-top: 1px dashed var(--line-soft);
	}
	@media (max-width: 900px) {
		.editor {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.editor__form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
	.editor__preview {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
		align-self: start;
		position: sticky;
		top: var(--space-4);
	}
	.fld {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
		gap: var(--space-4);
	}
	.area {
		width: 100%;
		min-height: 5rem;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sunk);
		color: var(--text);
		font: 400 14px/20px var(--font-text);
		resize: vertical;
	}
	.area.t-mono {
		font: 400 13px/18px var(--font-mono);
		white-space: pre;
		overflow-x: auto;
	}
	.area:focus-visible {
		outline: 0;
		border-color: var(--acc-ink);
		box-shadow: var(--focus-ring);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}
	.colour {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.swatch {
		width: var(--size-control);
		height: var(--size-control);
		padding: 2px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sunk);
		cursor: pointer;
		flex: none;
	}
	.colour__hex {
		width: 8rem;
	}
	.test {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		min-height: 1.5rem;
	}
	.when {
		white-space: nowrap;
	}
	.about {
		overflow-wrap: anywhere;
	}
	/* The switch, as in the visual editor's toggle field. */
	.tgl {
		display: inline-flex;
		align-items: center;
		gap: var(--space-3);
		cursor: pointer;
		position: relative;
	}
	.tgl input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
	}
	.tgl__track {
		position: relative;
		width: 36px;
		height: 20px;
		border-radius: 10px;
		background: var(--line);
		transition: background-color var(--duration-switch) var(--ease-glide);
		flex: none;
	}
	.tgl__knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--surface);
		box-shadow: var(--shadow-pill);
		transition: transform var(--duration-switch) var(--ease-glide);
	}
	.tgl input:checked + .tgl__track {
		background: var(--acc);
	}
	.tgl input:checked + .tgl__track .tgl__knob {
		transform: translateX(16px);
	}
	.tgl input:focus-visible + .tgl__track {
		box-shadow: var(--focus-ring);
	}
	.tgl input:disabled + .tgl__track {
		opacity: 0.6;
	}
	.tgl__hint {
		padding-left: calc(36px + var(--space-3));
		margin-top: calc(var(--space-3) * -1);
	}
</style>
