/**
 * The CodeMirror setup for the Caddyfile text editor: language, lint (W1 parser + W2 schema locally,
 * Caddy's `/adapt` on demand), autocomplete, hover docs, folding, bracket matching, search, history.
 */
import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import {
	forceLinting,
	linter,
	lintGutter,
	lintKeymap,
	type Diagnostic as CmDiagnostic
} from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
	EditorView,
	crosshairCursor,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection
} from '@codemirror/view';
import { parse } from '@caddy-ui/caddyfile';
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { analyze, type Analysis, type EditorDiagnostic } from './analyze';
import { caddyfileCompletion, caddyfileHover } from './assist';
import { caddyfile } from './language';

/** Diagnostics from Caddy (`/adapt`, `/load`) for one exact version of the text. */
export const setRemoteDiagnostics = StateEffect.define<{
	text: string;
	diagnostics: EditorDiagnostic[];
} | null>();

const remoteDiagnostics = StateField.define<{ text: string; diagnostics: EditorDiagnostic[] } | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setRemoteDiagnostics)) return e.value;
		// Caddy's answer describes the text it saw; once the text changes it no longer applies.
		return tr.docChanged ? null : value;
	}
});

function toCm(d: EditorDiagnostic, docLength: number): CmDiagnostic {
	const from = Math.min(d.from, docLength);
	return {
		from,
		to: Math.min(Math.max(d.to, from), docLength),
		severity: d.severity,
		source: d.source === 'adapt' || d.source === 'load' ? 'Caddy' : d.source,
		message: d.message
	};
}

/** Lint delay. PLAN.md §5.1 asks for a syntax error to be underlined within 300 ms. */
export const LINT_DELAY_MS = 150;

export type EditorOptions = {
	doc: string;
	getSchema: () => SchemaBundle | null;
	onChange?: (text: string) => void;
	/** Called after each local lint with the parse and every diagnostic (local and Caddy's), for the problems list and outline. */
	onAnalysis?: (a: { text: string; analysis: Analysis; diagnostics: EditorDiagnostic[] }) => void;
	readOnly?: boolean;
};

export const readOnlyCompartment = new Compartment();

export function editorExtensions(opts: EditorOptions): Extension[] {
	const lintSource = (view: EditorView): CmDiagnostic[] => {
		const text = view.state.doc.toString();
		const analysis = analyze(text, opts.getSchema());
		const local = analysis.diagnostics;
		const remote = view.state.field(remoteDiagnostics);
		const all = remote && remote.text === text ? [...local, ...remote.diagnostics] : local;
		opts.onAnalysis?.({ text, analysis, diagnostics: all });
		return all.map((d) => toCm(d, text.length));
	};
	return [
		lineNumbers(),
		highlightActiveLineGutter(),
		foldGutter(),
		highlightSpecialChars(),
		history(),
		drawSelection(),
		dropCursor(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		bracketMatching(),
		closeBrackets(),
		autocompletion({ override: [caddyfileCompletion(opts.getSchema)], icons: false }),
		caddyfileHover(opts.getSchema),
		rectangularSelection(),
		crosshairCursor(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		caddyfile(parse(opts.doc).file.indentUnit),
		remoteDiagnostics,
		linter(lintSource, {
			delay: LINT_DELAY_MS,
			needsRefresh: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setRemoteDiagnostics)))
		}),
		lintGutter(),
		readOnlyCompartment.of(EditorState.readOnly.of(opts.readOnly ?? false)),
		keymap.of([
			...closeBracketsKeymap,
			...defaultKeymap,
			...searchKeymap,
			...historyKeymap,
			...foldKeymap,
			...completionKeymap,
			...lintKeymap,
			indentWithTab
		]),
		EditorView.updateListener.of((u) => {
			if (u.docChanged) opts.onChange?.(u.state.doc.toString());
		}),
		EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' })
	];
}

/** Show Caddy's diagnostics for the current text and lint again right away. */
export function showRemoteDiagnostics(view: EditorView, diagnostics: EditorDiagnostic[]): void {
	view.dispatch({ effects: setRemoteDiagnostics.of({ text: view.state.doc.toString(), diagnostics }) });
	forceLinting(view);
}

/** Replace the whole text as one undoable change. */
export function replaceText(view: EditorView, text: string): void {
	const cur = view.state.doc.toString();
	if (cur === text) return;
	// Keep the change small so the cursor and undo history stay sensible.
	let start = 0;
	while (start < cur.length && start < text.length && cur[start] === text[start]) start++;
	let endA = cur.length;
	let endB = text.length;
	while (endA > start && endB > start && cur[endA - 1] === text[endB - 1]) {
		endA--;
		endB--;
	}
	view.dispatch({ changes: { from: start, to: endA, insert: text.slice(start, endB) } });
}

/** Move the cursor to a diagnostic and focus the editor. */
export function revealRange(view: EditorView, from: number, to: number): void {
	const len = view.state.doc.length;
	view.dispatch({
		selection: { anchor: Math.min(from, len), head: Math.min(to, len) },
		effects: EditorView.scrollIntoView(Math.min(from, len), { y: 'center' })
	});
	view.focus();
}

/** Lint again now, e.g. once the schema has loaded. */
export function relint(view: EditorView): void {
	forceLinting(view);
}

/** Cmd/Ctrl+S runs `save` instead of the browser's "save page". */
export function saveKeymap(save: () => void): Extension {
	return keymap.of([
		{
			key: 'Mod-s',
			preventDefault: true,
			run: () => {
				save();
				return true;
			}
		}
	]);
}

/** Editor chrome in Fishnet tokens: grounds, lines, accent, mono font. */
export const editorTheme = EditorView.theme({
	'&': { color: 'var(--text)', backgroundColor: 'var(--sunk)', fontSize: '13px' },
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px' },
	'.cm-content': { caretColor: 'var(--acc-ink)', padding: 'var(--space-2) 0' },
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--acc-ink)' },
	'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
		{ backgroundColor: 'var(--acc-soft)' },
	'.cm-activeLine': { backgroundColor: 'var(--hover-tint)' },
	'.cm-gutters': {
		backgroundColor: 'var(--surface)',
		color: 'var(--faint)',
		borderRight: '1px solid var(--line-soft)'
	},
	'.cm-activeLineGutter': { backgroundColor: 'var(--raised)', color: 'var(--text)' },
	'.cm-foldPlaceholder': {
		backgroundColor: 'var(--raised)',
		border: '1px solid var(--line)',
		color: 'var(--muted)',
		borderRadius: 'var(--radius-xs)'
	},
	'&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--acc-soft)', outline: '1px solid var(--acc)' },
	'&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--error-soft)' },
	'.cm-selectionMatch': { backgroundColor: 'var(--hover-tint)' },
	'.cm-searchMatch': { backgroundColor: 'var(--warning-soft)', outline: '1px solid var(--warning)' },
	'.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--acc-soft)' },
	'.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
	'.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
	'.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
	'.cm-panel input, .cm-panel button': { fontFamily: 'var(--font-text)' },
	'.cm-tooltip': {
		backgroundColor: 'var(--raised)',
		color: 'var(--text)',
		border: '1px solid var(--line)',
		borderRadius: 'var(--radius-md)',
		boxShadow: 'var(--shadow-float)'
	},
	'.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '16em' },
	'.cm-tooltip-autocomplete > ul > li[aria-selected]': {
		backgroundColor: 'var(--acc-soft)',
		color: 'var(--text)'
	},
	'.cm-completionDetail': { color: 'var(--faint)', fontStyle: 'normal', marginLeft: '1ch' },
	'.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--acc-ink)', fontWeight: '600' },
	'.cm-completionInfo': { maxWidth: '36em' },
	'.cm-tooltip-lint': { padding: '0' },
	'.cm-diagnostic': { fontFamily: 'var(--font-text)', padding: 'var(--space-1) var(--space-2)' },
	'.cm-diagnostic-error': { borderLeftColor: 'var(--error)' },
	'.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
	'.cm-diagnostic-info': { borderLeftColor: 'var(--acc)' },
	'.cm-diagnosticSource': { color: 'var(--faint)' },
	'.cm-lintRange-error': {
		backgroundImage: 'none',
		textDecoration: 'underline wavy var(--error)',
		textUnderlineOffset: '3px'
	},
	'.cm-lintRange-warning': {
		backgroundImage: 'none',
		textDecoration: 'underline wavy var(--warning)',
		textUnderlineOffset: '3px'
	},
	'.cm-lintRange-info': {
		backgroundImage: 'none',
		textDecoration: 'underline dotted var(--acc)',
		textUnderlineOffset: '3px'
	},
	'.cf-doc': {
		fontFamily: 'var(--font-text)',
		fontSize: '13px',
		lineHeight: '18px',
		padding: 'var(--space-2) var(--space-3)',
		maxWidth: '36em',
		display: 'flex',
		flexDirection: 'column',
		gap: 'var(--space-1)'
	},
	'.cf-doc p': { margin: '0' },
	'.cf-doc pre': {
		margin: '0',
		fontFamily: 'var(--font-mono)',
		fontSize: '12px',
		color: 'var(--muted)',
		whiteSpace: 'pre-wrap'
	},
	'.cf-doc__head': { display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' },
	'.cf-doc__head code': { fontFamily: 'var(--font-mono)', fontWeight: '600', color: 'var(--acc-ink)' },
	'.cf-doc__kind': { color: 'var(--faint)', fontSize: '12px' },
	'.cf-doc a': { color: 'var(--acc-ink)' }
});
