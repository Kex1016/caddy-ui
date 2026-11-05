<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { EditorView } from '@codemirror/view';
	import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
	import type { Analysis, EditorDiagnostic } from './analyze';

	type Props = {
		/** Text the editor starts with. Later changes to this prop do not reset the editor; call setText. */
		text: string;
		schema: SchemaBundle | null;
		onchange?: (text: string) => void;
		onanalysis?: (a: { text: string; analysis: Analysis; diagnostics: EditorDiagnostic[] }) => void;
		/** Cmd/Ctrl+S. */
		onsave?: () => void;
		label?: string;
	};
	let { text, schema, onchange, onanalysis, onsave, label = 'Caddyfile text' }: Props = $props();

	let host: HTMLDivElement;
	let view: EditorView | null = null;
	let api: typeof import('./setup') | null = null;
	let ready = $state(false);
	// Read by the completion, hover and lint sources at call time, so a schema that arrives later is used.
	let currentSchema: SchemaBundle | null = null;
	$effect(() => {
		currentSchema = schema;
		if (view && api && schema) api.relint(view);
	});

	onMount(() => {
		let cancelled = false;
		// CodeMirror is loaded only in the browser, and only on this page.
		void Promise.all([import('./setup'), import('@codemirror/view'), import('@codemirror/state')]).then(
			([setup, cmView, cmState]) => {
				if (cancelled) return;
				api = setup;
				view = new cmView.EditorView({
					parent: host,
					state: cmState.EditorState.create({
						doc: text,
						extensions: [
							...setup.editorExtensions({
								doc: text,
								getSchema: () => currentSchema,
								onChange: (t) => onchange?.(t),
								onAnalysis: (a) => onanalysis?.(a)
							}),
							setup.saveKeymap(() => onsave?.()),
							setup.editorTheme,
							cmView.EditorView.contentAttributes.of({ 'aria-label': label })
						]
					})
				});
				ready = true;
			}
		);
		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => view?.destroy());

	/** Replace the text as one undoable change (format, reload from disk). */
	export function setText(next: string): void {
		if (view && api) api.replaceText(view, next);
	}
	export function getText(): string {
		return view?.state.doc.toString() ?? text;
	}
	/** Show Caddy's `/adapt` or `/load` diagnostics until the text changes. */
	export function showCaddyDiagnostics(diags: EditorDiagnostic[]): void {
		if (view && api) api.showRemoteDiagnostics(view, diags);
	}
	export function reveal(from: number, to: number = from): void {
		if (view && api) api.revealRange(view, from, to);
	}
	export function focus(): void {
		view?.focus();
	}
</script>

<div class="cf-editor" class:cf-editor--loading={!ready} bind:this={host}>
	{#if !ready}
		<pre class="cf-editor__fallback" aria-busy="true">{text}</pre>
	{/if}
</div>

<style>
	.cf-editor {
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--sunk);
		overflow: hidden;
		min-height: 320px;
		height: min(72vh, 900px);
		display: flex;
	}
	.cf-editor :global(.cm-editor) {
		flex: 1;
		min-width: 0;
		height: 100%;
	}
	.cf-editor__fallback {
		margin: 0;
		padding: var(--space-2) var(--space-3) var(--space-2) 52px;
		font: 400 13px/20px var(--font-mono);
		color: var(--muted);
		white-space: pre;
		tab-size: 4;
		overflow: auto;
		width: 100%;
	}

	/* Syntax colours: Fishnet tokens only, so both themes and the caddy theme apply. */
	.cf-editor :global(.cf-comment) {
		color: var(--faint);
		font-style: italic;
	}
	.cf-editor :global(.cf-address) {
		color: var(--text);
		font-weight: 700;
	}
	.cf-editor :global(.cf-snippet) {
		color: var(--acc-ink);
		font-weight: 700;
	}
	.cf-editor :global(.cf-directive) {
		color: var(--acc-ink);
		font-weight: 600;
	}
	.cf-editor :global(.cf-subdirective) {
		color: var(--acc-ink);
	}
	.cf-editor :global(.cf-matcher) {
		color: var(--warning-ink);
	}
	.cf-editor :global(.cf-placeholder) {
		color: var(--success-ink);
	}
	.cf-editor :global(.cf-env) {
		color: var(--success-ink);
		text-decoration: underline dotted;
		text-underline-offset: 3px;
	}
	.cf-editor :global(.cf-string) {
		color: var(--muted);
	}
	.cf-editor :global(.cf-heredoc) {
		color: var(--faint);
		font-weight: 600;
	}
	.cf-editor :global(.cf-number) {
		color: var(--text);
	}
	.cf-editor :global(.cf-brace) {
		color: var(--faint);
	}
</style>
