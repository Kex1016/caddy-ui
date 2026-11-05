<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { beforeNavigate } from '$app/navigation';
	import { format } from '@caddy-ui/caddyfile';
	import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
	import { Notice, PageHero, Tag } from '$lib/design/components';
	import { formatDateTime } from '$lib/format';
	import DiffView from '$lib/editor/DiffView.svelte';
	import TextEditor from '$lib/editor/TextEditor.svelte';
	import { LineIndex, outline, type EditorDiagnostic, type OutlineItem } from '$lib/editor/analyze';
	import {
		applyText,
		caddyDiagnostics,
		loadDocument,
		loadSchema,
		readDraft,
		validateText,
		writeDraft
	} from '$lib/editor/api';

	let { data } = $props();

	type Msg = { kind: 'info' | 'success' | 'warning' | 'error'; text: string };

	// What is on disk as far as this page knows; `hash` goes back to the server as `baseHash`.
	// svelte-ignore state_referenced_locally
	let base = $state({ text: data.doc.text, hash: data.doc.hash });
	// svelte-ignore state_referenced_locally
	let current = $state(data.doc.text);
	let schema = $state.raw<SchemaBundle | null>(null);
	let schemaError = $state<string | null>(null);
	let diagnostics = $state.raw<EditorDiagnostic[]>([]);
	let lintedText = $state('');
	let blocks = $state.raw<OutlineItem[]>([]);
	let mode = $state<'edit' | 'review'>('edit');
	let busy = $state<null | 'validate' | 'apply' | 'reload'>(null);
	let message = $state<Msg | null>(null);
	let conflict = $state(false);
	let restoredDraft = $state(false);
	let note = $state('');
	let editor = $state<TextEditor>();

	const dirty = $derived(current !== base.text);
	const errors = $derived(diagnostics.filter((d) => d.severity === 'error').length);
	const warnings = $derived(diagnostics.filter((d) => d.severity === 'warning').length);
	const syntaxErrors = $derived(diagnostics.some((d) => d.source === 'parser' && d.severity === 'error'));
	const lines = $derived(new LineIndex(lintedText));

	const storage = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

	onMount(() => {
		loadSchema().then(
			(s) => (schema = s),
			(err) => (schemaError = err instanceof Error ? err.message : String(err))
		);
		const draft = readDraft(storage());
		if (draft && draft.baseHash === base.hash && draft.text !== base.text) {
			restoredDraft = true;
			// Wait for the editor to mount, then put the draft in as one undoable change.
			const t = setInterval(() => {
				if (editor) {
					editor.setText(draft.text);
					clearInterval(t);
				}
			}, 50);
			setTimeout(() => clearInterval(t), 5000);
		} else if (draft) {
			writeDraft(storage(), null);
		}
		// `?at=<address>` scrolls to that site block; `?line=N` (the sites list's link) to that line.
		const at = page.url.searchParams.get('at');
		const lineParam = Number(page.url.searchParams.get('line'));
		if (at || (Number.isSafeInteger(lineParam) && lineParam > 0)) {
			const t = setInterval(() => {
				const from = at
					? blocks.find((b) => b.label.split(', ').includes(at))?.from
					: blocks.length
						? new LineIndex(base.text).offset(lineParam)
						: undefined;
				if (from !== undefined && editor) {
					editor.reveal(from);
					clearInterval(t);
				}
			}, 100);
			setTimeout(() => clearInterval(t), 5000);
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
		current = text;
		clearTimeout(draftTimer);
		draftTimer = setTimeout(() => {
			writeDraft(storage(), text === base.text ? null : { baseHash: base.hash, text, savedAt: Date.now() });
		}, 400);
	}

	function onanalysis(a: {
		text: string;
		analysis: import('$lib/editor/analyze').Analysis;
		diagnostics: EditorDiagnostic[];
	}) {
		lintedText = a.text;
		diagnostics = a.diagnostics;
		blocks = outline(a.analysis.file, a.text);
	}

	function doFormat() {
		if (!editor) return;
		if (syntaxErrors) {
			message = {
				kind: 'warning',
				text: 'Fix the syntax errors first; formatting needs a file the parser understands.'
			};
			return;
		}
		const text = editor.getText();
		const next = format(text);
		if (next === text) message = { kind: 'info', text: 'Already formatted.' };
		else {
			editor.setText(next);
			message = { kind: 'success', text: 'Formatted in caddy fmt style. Undo with Ctrl+Z.' };
		}
	}

	async function doValidate() {
		if (!editor) return;
		busy = 'validate';
		const text = editor.getText();
		const r = await validateText(text);
		busy = null;
		if (r.ok === null) {
			message = { kind: 'error', text: r.message };
			return;
		}
		const caddy = caddyDiagnostics(text, r.diagnostics);
		editor.showCaddyDiagnostics(caddy);
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
		mode = 'review';
	}

	async function doApply() {
		if (!editor) return;
		busy = 'apply';
		const text = editor.getText();
		const r = await applyText(text, base.hash, note);
		busy = null;
		switch (r.kind) {
			case 'applied': {
				base = { text, hash: r.result.hash };
				writeDraft(storage(), null);
				restoredDraft = false;
				conflict = false;
				note = '';
				mode = 'edit';
				const rev = r.result.revision ? ` Saved as revision #${r.result.revision.id}.` : '';
				message = r.result.changed
					? { kind: 'success', text: `Applied. Caddy reloaded the new config.${rev}` }
					: { kind: 'info', text: 'Nothing changed: the file and the running config already match.' };
				const warn = caddyDiagnostics(text, r.result.diagnostics);
				if (warn.length) editor.showCaddyDiagnostics(warn);
				break;
			}
			case 'conflict':
				conflict = true;
				mode = 'edit';
				message = null;
				break;
			case 'refused':
				mode = 'edit';
				editor.showCaddyDiagnostics(caddyDiagnostics(text, r.diagnostics));
				message = {
					kind: 'error',
					text: `${r.message}. Nothing was changed; the problems are marked in the text.`
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
			const doc = await loadDocument();
			base = { text: doc.text, hash: doc.hash };
			conflict = false;
			if (keepEdits) {
				mode = 'review';
				message = {
					kind: 'info',
					text: 'Below are your edits compared with the file as it is on disk now. Applying replaces it.'
				};
				writeDraft(storage(), { baseHash: doc.hash, text: current, savedAt: Date.now() });
			} else {
				editor?.setText(doc.text);
				writeDraft(storage(), null);
				restoredDraft = false;
				mode = 'edit';
				message = { kind: 'info', text: 'Loaded the file as it is on disk now.' };
			}
		} catch (err) {
			message = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
		} finally {
			busy = null;
		}
	}

	function discardDraft() {
		editor?.setText(base.text);
		writeDraft(storage(), null);
		restoredDraft = false;
	}

	function jump(e: Event) {
		const from = Number((e.currentTarget as HTMLSelectElement).value);
		if (Number.isFinite(from) && from >= 0) editor?.reveal(from);
		(e.currentTarget as HTMLSelectElement).value = '';
	}
</script>

<PageHero
	kicker="Caddyfile"
	title="Editor"
	lede="Edit the Caddyfile as text. Problems are marked as you type; Caddy checks the file again before anything is written, and you see the changes before they apply."
/>

{#if data.doc.parser === 'unavailable'}
	<section class="fp-section">
		<Notice kind="warning"
			>The Caddyfile parser is not installed on the server, so formatting and local checks are limited.</Notice
		>
	</section>
{/if}
{#if data.doc.externalChange}
	<section class="fp-section">
		<Notice kind="warning">
			<b>Edited outside the UI.</b> The Caddyfile changed on disk at {formatDateTime(
				data.doc.externalChange.at,
				data.timeZone
			)}. The editor shows that version.
		</Notice>
	</section>
{/if}
{#if data.doc.drift.state === 'file_differs'}
	<section class="fp-section">
		<Notice kind="warning"
			><b>Not applied.</b> {data.doc.drift.message}. Applying from here loads the file into Caddy.</Notice
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
	<section class="fp-section">
		<Notice kind={message.kind}>{message.text}</Notice>
	</section>
{/if}

<section class="fp-section editor">
	<div class="bar">
		<div class="bar__start">
			<label class="fp-select jump">
				<span class="visually-hidden">Jump to block</span>
				<select onchange={jump} disabled={mode !== 'edit' || blocks.length === 0}>
					<option value="">Jump to block…</option>
					{#each blocks as b (b.from)}
						<option value={b.from}>{b.label}</option>
					{/each}
				</select>
			</label>
			<span class="status t-ui" aria-live="polite">
				{#if dirty}<Tag kind="acc">unapplied edits</Tag>{:else}<Tag>matches disk</Tag>{/if}
				{#if errors}<Tag kind="error">{errors} {errors === 1 ? 'error' : 'errors'}</Tag>{/if}
				{#if warnings}<Tag kind="warning">{warnings} {warnings === 1 ? 'warning' : 'warnings'}</Tag>{/if}
				{#if !schema && !schemaError}<span class="t-muted">loading directive docs…</span>{/if}
			</span>
		</div>
		<div class="bar__end">
			{#if mode === 'edit'}
				<button class="fp-btn" type="button" onclick={doFormat} disabled={busy !== null}>Format</button>
				<button class="fp-btn" type="button" onclick={doValidate} disabled={busy !== null}>
					{busy === 'validate' ? 'Checking…' : 'Check with Caddy'}
				</button>
				<button
					class="fp-btn fp-btn--primary"
					type="button"
					onclick={review}
					disabled={busy !== null || !dirty}
				>
					Review and apply
				</button>
			{:else}
				<button class="fp-btn" type="button" onclick={() => (mode = 'edit')} disabled={busy === 'apply'}
					>Back to editing</button
				>
			{/if}
		</div>
	</div>

	{#if schemaError}
		<p class="t-ui t-muted">Directive docs and completion are off: {schemaError}.</p>
	{/if}

	<div hidden={mode !== 'edit'}>
		<TextEditor bind:this={editor} text={base.text} {schema} {onchange} {onanalysis} onsave={review} />
		<p class="t-ui t-muted keys">
			<kbd>Ctrl</kbd>+<kbd>Space</kbd> completes · <kbd>Ctrl</kbd>+<kbd>S</kbd> reviews ·
			<kbd>Ctrl</kbd>+<kbd>F</kbd> searches · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> folds a block · hover
			a directive for its docs
		</p>
	</div>

	{#if mode === 'review'}
		<div class="fp-panel review">
			<h2 class="t-title-3">Review the change</h2>
			<DiffView before={base.text} after={current} label="Changes to apply" />
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

	{#if mode === 'edit' && diagnostics.length}
		<div class="fp-panel problems">
			<h2 class="t-title-4">Problems</h2>
			<ul>
				{#each diagnostics.slice(0, 200) as d, i (i)}
					<li>
						<button type="button" class="problem" onclick={() => editor?.reveal(d.from, d.to)}>
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
	.editor {
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
	.jump select {
		max-width: 22rem;
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
