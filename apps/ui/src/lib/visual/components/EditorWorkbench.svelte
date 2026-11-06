<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { beforeNavigate, replaceState } from '$app/navigation';
	import { Columns2 } from '@lucide/svelte';
	import { format } from '@caddy-ui/caddyfile';
	import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
	import type { CaddyfileDoc } from '$lib/api/config';
	import { Notice, Tag } from '$lib/design/components';
	import { formatDateTime } from '$lib/format';
	import DiffView from '$lib/editor/DiffView.svelte';
	import TextEditor from '$lib/editor/TextEditor.svelte';
	import { analyze, LineIndex, type Analysis, type EditorDiagnostic } from '$lib/editor/analyze';
	import {
		applyText,
		caddyDiagnostics,
		loadDocument as fetchDocument,
		loadSchema,
		readDraft,
		validateText,
		writeDraft
	} from '$lib/editor/api';
	import VisualEditor from './VisualEditor.svelte';

	type Props = {
		doc: Pick<CaddyfileDoc, 'text' | 'hash' | 'parser' | 'drift' | 'externalChange'>;
		timeZone: string;
		/** `globals` shows only the non-site blocks in the outline (the Globals page). */
		scope?: 'all' | 'globals';
		/** Site ids (as the Sites page links them) with the line each block starts on, for `?site=`. */
		sites?: readonly { id: string; line: number }[];
		initialMode?: 'visual' | 'text';
	};
	let { doc, timeZone, scope = 'all', sites = [], initialMode = 'visual' }: Props = $props();

	type Msg = { kind: 'info' | 'success' | 'warning' | 'error'; text: string };
	type Mode = 'visual' | 'text';

	// What is on disk as far as this page knows; `hash` goes back to the server as `baseHash`.
	// svelte-ignore state_referenced_locally
	let base = $state({ text: doc.text, hash: doc.hash });
	// svelte-ignore state_referenced_locally
	let current = $state(doc.text);
	let schema = $state.raw<SchemaBundle | null>(null);
	let schemaError = $state<string | null>(null);
	// svelte-ignore state_referenced_locally
	let mode = $state<Mode>(initialMode);
	let split = $state(false);
	let stage = $state<'edit' | 'review'>('edit');
	let busy = $state<null | 'validate' | 'apply' | 'reload'>(null);
	let message = $state<Msg | null>(null);
	let conflict = $state(false);
	let restoredDraft = $state(false);
	let note = $state('');
	let editor = $state<TextEditor>();
	let visual = $state<VisualEditor>();
	let textDiagnostics = $state.raw<EditorDiagnostic[]>([]);
	let lintedText = $state('');
	let caddyMarks = $state.raw<EditorDiagnostic[]>([]);

	const textLive = $derived(mode === 'text' || split);
	const dirty = $derived(current !== base.text);
	const analysis = $derived<Analysis | null>(textLive ? null : analyze(current, schema));
	const diagnostics = $derived<EditorDiagnostic[]>(
		textLive ? textDiagnostics : [...(analysis?.diagnostics ?? []), ...caddyMarks]
	);
	const errors = $derived(diagnostics.filter((d) => d.severity === 'error').length);
	const warnings = $derived(diagnostics.filter((d) => d.severity === 'warning').length);
	const syntaxErrors = $derived(diagnostics.some((d) => d.source === 'parser' && d.severity === 'error'));
	const lines = $derived(new LineIndex(textLive ? lintedText : current));
	/** What a save writes: every save is formatted, so the review shows the caddy fmt form. */
	const toWrite = $derived.by(() => {
		if (syntaxErrors) return current;
		try {
			return format(current);
		} catch {
			return current;
		}
	});

	const storage = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

	/** Push `current` into the text editor once it is ready (it loads CodeMirror asynchronously). */
	function syncEditor(text: string) {
		if (!editor) return;
		if (editor.getText() === text) return;
		editor.setText(text);
		if (editor.getText() === text) return;
		const t = setInterval(() => {
			if (editor && editor.getText() !== text) editor.setText(text);
			if (editor && editor.getText() === text) clearInterval(t);
		}, 50);
		setTimeout(() => clearInterval(t), 5000);
	}
	$effect(() => {
		// Visual edits (and applies) flow into the text editor whenever it is showing.
		if (textLive) syncEditor(current);
	});

	function setMode(m: Mode) {
		if (m === mode) return;
		if (m === 'text') syncEditor(current);
		mode = m;
		if (m === 'visual') split = false;
		try {
			const url = new URL(page.url);
			if (m === 'visual') url.searchParams.delete('mode');
			else url.searchParams.set('mode', m);
			replaceState(url, page.state);
		} catch {
			/* not navigable yet */
		}
	}

	function revealOffset(from: number, to = from) {
		if (textLive) editor?.reveal(from, to);
		else visual?.selectOffset(from);
	}

	function showInText(offset: number) {
		setMode('text');
		const t = setInterval(() => {
			if (editor && editor.getText() === current) {
				editor.reveal(offset);
				editor.focus();
				clearInterval(t);
			}
		}, 50);
		setTimeout(() => clearInterval(t), 3000);
	}

	onMount(() => {
		loadSchema().then(
			(s) => (schema = s),
			(err) => (schemaError = err instanceof Error ? err.message : String(err))
		);
		const draft = readDraft(storage());
		if (draft && draft.baseHash === base.hash && draft.text !== base.text) {
			restoredDraft = true;
			current = draft.text;
			if (textLive) syncEditor(draft.text);
		} else if (draft) {
			writeDraft(storage(), null);
		}
		// `?at=<address>` and `?site=<id>` open that site block; `?line=N` that line; `?block=global|snippets`.
		const params = page.url.searchParams;
		const at = params.get('at');
		const siteId = params.get('site');
		const block = params.get('block');
		let lineParam = Number(params.get('line'));
		if (siteId && !(lineParam > 0)) lineParam = sites.find((s) => s.id === siteId)?.line ?? 0;
		const a = analyze(current, null);
		let offset: number | undefined;
		if (at)
			offset = a.file.blocks.find((b) => b.kind === 'site' && b.addresses.some((t) => t.text === at))?.span
				?.start;
		else if (Number.isSafeInteger(lineParam) && lineParam > 0)
			offset = new LineIndex(current).offset(lineParam);
		else if (block === 'global') offset = a.file.blocks.find((b) => b.kind === 'global')?.span?.start;
		else if (block === 'snippets') offset = a.file.blocks.find((b) => b.kind === 'snippet')?.span?.start;
		if (offset !== undefined) {
			const target = offset;
			if (textLive) {
				const t = setInterval(() => {
					if (editor && editor.getText() === current) {
						editor.reveal(target);
						clearInterval(t);
					}
				}, 100);
				setTimeout(() => clearInterval(t), 5000);
			} else {
				const found = visual?.selectOffset(target);
				if (!found) requestAnimationFrame(() => visual?.selectOffset(target));
			}
		}
		const warn = (e: BeforeUnloadEvent) => {
			if (current !== base.text) e.preventDefault();
		};
		addEventListener('beforeunload', warn);
		return () => removeEventListener('beforeunload', warn);
	});

	beforeNavigate((nav) => {
		if (
			dirty &&
			nav.type !== 'leave' &&
			!confirm('Leave the editor? Your unapplied edits stay saved in this browser.')
		)
			nav.cancel();
	});

	let draftTimer: ReturnType<typeof setTimeout> | undefined;
	function onchange(text: string) {
		if (text === current) return;
		current = text;
		caddyMarks = [];
		clearTimeout(draftTimer);
		draftTimer = setTimeout(() => {
			writeDraft(storage(), text === base.text ? null : { baseHash: base.hash, text, savedAt: Date.now() });
		}, 400);
	}

	function onanalysis(a: { text: string; analysis: Analysis; diagnostics: EditorDiagnostic[] }) {
		lintedText = a.text;
		textDiagnostics = a.diagnostics;
	}

	function doFormat() {
		if (syntaxErrors) {
			message = {
				kind: 'warning',
				text: 'Fix the syntax errors first; formatting needs a file the parser understands.'
			};
			return;
		}
		const next = format(current);
		if (next === current) message = { kind: 'info', text: 'Already formatted.' };
		else {
			if (textLive && editor) editor.setText(next);
			else onchange(next);
			message = {
				kind: 'success',
				text: textLive ? 'Formatted in caddy fmt style. Undo with Ctrl+Z.' : 'Formatted in caddy fmt style.'
			};
		}
	}

	function showCaddy(text: string, diags: Parameters<typeof caddyDiagnostics>[1]) {
		const marks = caddyDiagnostics(text, diags);
		if (textLive) editor?.showCaddyDiagnostics(marks);
		else caddyMarks = marks;
	}

	async function doValidate() {
		busy = 'validate';
		const text = current;
		const r = await validateText(text);
		busy = null;
		if (r.ok === null) {
			message = { kind: 'error', text: r.message };
			return;
		}
		showCaddy(text, r.diagnostics);
		const first = r.diagnostics.find((d) => d.severity === 'error');
		message = r.ok
			? { kind: 'success', text: 'Caddy accepts this Caddyfile. Nothing was written or reloaded.' }
			: { kind: 'error', text: `Caddy refuses it: ${first?.message ?? 'see the problems below'}` };
	}

	function review() {
		if (!dirty) {
			message = { kind: 'info', text: 'Nothing to apply: the text matches the file on disk.' };
			return;
		}
		message = null;
		stage = 'review';
	}

	async function doApply() {
		busy = 'apply';
		const text = current;
		const r = await applyText(text, base.hash, note);
		busy = null;
		switch (r.kind) {
			case 'applied': {
				// Every save is written in caddy fmt style, so the file may differ from what was sent.
				base = { text: r.result.text, hash: r.result.hash };
				current = r.result.text;
				if (textLive) syncEditor(r.result.text);
				writeDraft(storage(), null);
				restoredDraft = false;
				conflict = false;
				note = '';
				stage = 'edit';
				const rev = r.result.revision ? ` Saved as revision #${r.result.revision.id}.` : '';
				const fmt = r.result.formatted ? ' The file was saved in caddy fmt style.' : '';
				message = !r.result.changed
					? { kind: 'info', text: `Nothing changed: the file and the running config already match.${fmt}` }
					: r.result.loaded
						? { kind: 'success', text: `Applied. Caddy reloaded the new config.${fmt}${rev}` }
						: { kind: 'success', text: `Saved. Caddy's running config is unchanged.${fmt}${rev}` };
				if (r.result.diagnostics.length) showCaddy(r.result.text, r.result.diagnostics);
				break;
			}
			case 'conflict':
				conflict = true;
				stage = 'edit';
				message = null;
				break;
			case 'refused':
				stage = 'edit';
				showCaddy(text, r.diagnostics);
				message = {
					kind: 'error',
					text: `${r.message}. Nothing was changed; the problems are marked below.`
				};
				break;
			case 'signed_out':
				message = {
					kind: 'error',
					text: 'Your session ended. Sign in again in another tab, then apply; your edits are kept here.'
				};
				break;
			case 'failed':
				message = { kind: 'error', text: r.message };
		}
	}

	/** After a conflict: take the file on disk as the new base, keeping (or dropping) the edits. */
	async function reloadFromDisk(keepEdits: boolean) {
		busy = 'reload';
		try {
			const d = await fetchDocument();
			base = { text: d.text, hash: d.hash };
			conflict = false;
			if (keepEdits) {
				stage = 'review';
				message = {
					kind: 'info',
					text: 'Below are your edits compared with the file as it is on disk now. Applying replaces it.'
				};
				writeDraft(storage(), { baseHash: d.hash, text: current, savedAt: Date.now() });
			} else {
				current = d.text;
				if (textLive) syncEditor(d.text);
				writeDraft(storage(), null);
				restoredDraft = false;
				stage = 'edit';
				message = { kind: 'info', text: 'Loaded the file as it is on disk now.' };
			}
		} catch (err) {
			message = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
		} finally {
			busy = null;
		}
	}

	function discardDraft() {
		current = base.text;
		if (textLive) syncEditor(base.text);
		writeDraft(storage(), null);
		restoredDraft = false;
	}
</script>

{#if doc.parser === 'unavailable'}
	<section class="fp-section">
		<Notice kind="warning"
			>The Caddyfile parser is not installed on the server, so formatting and local checks are limited.</Notice
		>
	</section>
{/if}
{#if doc.externalChange}
	<section class="fp-section">
		<Notice kind="warning">
			<b>Edited outside the UI.</b> The Caddyfile changed on disk at {formatDateTime(
				doc.externalChange.at,
				timeZone
			)}. The editor shows that version.
		</Notice>
	</section>
{/if}
{#if doc.drift.state === 'file_differs'}
	<section class="fp-section">
		<Notice kind="warning"
			><b>Not applied.</b> {doc.drift.message}. Applying from here loads the file into Caddy.</Notice
		>
	</section>
{/if}
{#if restoredDraft}
	<section class="fp-section">
		<Notice>
			<b>Unapplied edits restored.</b> This browser kept edits you had not applied yet.
			<button class="fp-btn fp-btn--quiet link" type="button" onclick={discardDraft}>Discard them</button>
		</Notice>
	</section>
{/if}
{#if conflict}
	<section class="fp-section">
		<Notice kind="warning">
			<b>The file changed on disk since you opened it.</b> Someone or something else saved it, so applying now
			would overwrite that change.
			<span class="actions">
				<button class="fp-btn" type="button" disabled={busy !== null} onclick={() => reloadFromDisk(true)}
					>Compare my edits with it</button
				>
				<button
					class="fp-btn fp-btn--quiet"
					type="button"
					disabled={busy !== null}
					onclick={() => reloadFromDisk(false)}>Drop my edits and load it</button
				>
			</span>
		</Notice>
	</section>
{/if}
{#if message}
	<section class="fp-section" aria-live="polite">
		<Notice kind={message.kind}>{message.text}</Notice>
	</section>
{/if}

<section class="fp-section wb">
	<div class="bar">
		<div class="bar__start">
			<div class="fp-seg" role="group" aria-label="Editor mode">
				<button
					type="button"
					aria-pressed={mode === 'visual'}
					onclick={() => setMode('visual')}
					disabled={stage !== 'edit'}>Visual</button
				>
				<button
					type="button"
					aria-pressed={mode === 'text'}
					onclick={() => setMode('text')}
					disabled={stage !== 'edit'}>Text</button
				>
			</div>
			{#if mode === 'visual'}
				<button
					class="fp-btn fp-btn--quiet"
					type="button"
					aria-pressed={split}
					onclick={() => (split = !split)}
					disabled={stage !== 'edit'}
					title="Show the text beside the outline"
				>
					<Columns2 class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" /> Split
				</button>
			{/if}
			<span class="status t-ui" aria-live="polite">
				{#if dirty}<Tag kind="acc">unapplied edits</Tag>{:else}<Tag>matches disk</Tag>{/if}
				{#if errors}<Tag kind="error">{errors} {errors === 1 ? 'error' : 'errors'}</Tag>{/if}
				{#if warnings}<Tag kind="warning">{warnings} {warnings === 1 ? 'warning' : 'warnings'}</Tag>{/if}
				{#if !schema && !schemaError}<span class="t-muted">loading directive docs…</span>{/if}
			</span>
		</div>
		<div class="bar__end">
			{#if stage === 'edit'}
				<button class="fp-btn" type="button" onclick={doFormat} disabled={busy !== null}>Format</button>
				<button class="fp-btn" type="button" onclick={doValidate} disabled={busy !== null}>
					{busy === 'validate' ? 'Checking…' : 'Check with Caddy'}
				</button>
				<button
					class="fp-btn fp-btn--primary"
					type="button"
					onclick={review}
					disabled={busy !== null || !dirty}>Review and apply</button
				>
			{:else}
				<button class="fp-btn" type="button" onclick={() => (stage = 'edit')} disabled={busy === 'apply'}
					>Back to editing</button
				>
			{/if}
		</div>
	</div>

	{#if schemaError}
		<p class="t-ui t-muted">Directive docs and forms are limited: {schemaError}.</p>
	{/if}

	<div class="panes" class:panes--split={split && mode === 'visual'} hidden={stage !== 'edit'}>
		<div class="pane" hidden={mode !== 'visual'}>
			<VisualEditor bind:this={visual} text={current} {schema} {onchange} {scope} onshowtext={showInText} />
		</div>
		<div class="pane" hidden={!textLive}>
			<TextEditor bind:this={editor} text={base.text} {schema} {onchange} {onanalysis} onsave={review} />
			<p class="t-ui t-muted keys">
				<kbd>Ctrl</kbd>+<kbd>Space</kbd> completes · <kbd>Ctrl</kbd>+<kbd>S</kbd> reviews ·
				<kbd>Ctrl</kbd>+<kbd>F</kbd> searches ·
				<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> folds a block · hover a directive for its docs
			</p>
		</div>
	</div>

	{#if stage === 'review'}
		<div class="fp-panel review">
			<h2 class="t-title-3">Review the change</h2>
			{#if toWrite !== current}
				<p class="t-ui t-muted">
					Every save is written in caddy fmt style, so this compares the formatted result with the file on
					disk.
				</p>
			{/if}
			<DiffView before={base.text} after={toWrite} label="Changes to apply" />
			{#if errors}
				<Notice kind="warning">
					The editor found {errors}
					{errors === 1 ? 'problem' : 'problems'}. Caddy checks the file again before writing; if it refuses,
					nothing changes.
				</Notice>
			{/if}
			<div class="review__foot">
				<label class="fp-field note">
					<span class="visually-hidden">Note for the history</span>
					<input bind:value={note} maxlength="200" placeholder="Note for the history (optional)" />
				</label>
				<button class="fp-btn fp-btn--primary" type="button" onclick={doApply} disabled={busy !== null}>
					{busy === 'apply' ? 'Applying…' : 'Apply and reload Caddy'}
				</button>
			</div>
		</div>
	{/if}

	{#if stage === 'edit' && diagnostics.length}
		<div class="fp-panel problems">
			<h2 class="t-title-4">Problems</h2>
			<ul>
				{#each diagnostics.slice(0, 200) as d, i (i)}
					<li>
						<button type="button" class="problem" onclick={() => revealOffset(d.from, d.to)}>
							<Tag kind={d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'acc'}
								>{d.severity}</Tag
							>
							<span class="problem__where">line {lines.lineOf(d.from)}</span>
							<span class="problem__msg">{d.message}</span>
							<span class="problem__src"
								>{d.source === 'adapt' || d.source === 'load' ? 'Caddy' : d.source}</span
							>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>

<style>
	.wb {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		align-items: center;
		justify-content: space-between;
	}
	.bar__start,
	.bar__end,
	.status {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
	}
	.panes {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-4);
		min-width: 0;
	}
	.panes[hidden],
	.pane[hidden] {
		display: none;
	}
	.panes--split {
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	}
	@media (max-width: 1100px) {
		.panes--split {
			grid-template-columns: 1fr;
		}
	}
	.pane {
		min-width: 0;
	}
	.keys {
		margin-top: var(--space-2);
	}
	kbd {
		font: 500 11px/16px var(--font-mono);
		padding: 0 var(--space-1);
		border: 1px solid var(--line);
		border-radius: var(--radius-xs);
		background: var(--surface);
	}
	.actions {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-left: var(--space-2);
	}
	.link {
		height: auto;
		padding: 0 var(--space-1);
		color: var(--acc-ink);
	}
	.review {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.review__foot {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		justify-content: flex-end;
	}
	.note {
		flex: 1;
		min-width: 14rem;
	}
	.problems ul {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
		max-height: 16rem;
		overflow: auto;
	}
	.problem {
		display: grid;
		grid-template-columns: auto 6ch 1fr auto;
		gap: var(--space-2);
		align-items: center;
		width: 100%;
		padding: var(--space-1) var(--space-2);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font: 400 14px/20px var(--font-text);
		text-align: left;
		cursor: pointer;
	}
	.problem:hover {
		background: var(--hover-tint);
	}
	.problem__where,
	.problem__src {
		font: 400 12px/16px var(--font-mono);
		color: var(--faint);
	}
	@media (max-width: 640px) {
		.problem {
			grid-template-columns: auto 1fr;
		}
		.problem__where,
		.problem__src {
			display: none;
		}
	}
</style>
