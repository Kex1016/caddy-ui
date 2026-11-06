/**
 * Browser calls the text editor makes to the config routes (W3), with every outcome as a value so the
 * page can show it: applied, conflict (409), refused by Caddy (422/502/503), signed out, or a network
 * failure.
 */
import type { ApplyFailure, ApplyResult, CaddyfileDoc, Diagnostic, ValidateResult } from '$lib/api/config';
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { placeLineDiagnostics, type EditorDiagnostic } from './analyze';

export type ApplyOutcome =
	| { kind: 'applied'; result: ApplyResult }
	| { kind: 'conflict'; message: string; currentHash?: string }
	| { kind: 'refused'; message: string; diagnostics: Diagnostic[] }
	| { kind: 'signed_out' }
	| { kind: 'failed'; message: string };

type Fetch = typeof fetch;

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

const messageOf = (body: unknown, fallback: string) =>
	body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
		? (body as { message: string }).message
		: fallback;

export async function applyText(
	text: string,
	baseHash: string,
	note: string,
	f: Fetch = fetch
): Promise<ApplyOutcome> {
	let res: Response;
	try {
		res = await f('/api/caddyfile', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text, baseHash, note: note.trim() || undefined })
		});
	} catch (err) {
		return { kind: 'failed', message: `Could not reach the UI server: ${String(err)}` };
	}
	const body = await readJson(res);
	if (res.ok) return { kind: 'applied', result: body as ApplyResult };
	if (res.status === 401) return { kind: 'signed_out' };
	if (res.status === 409) {
		const b = body as ApplyFailure | null;
		return {
			kind: 'conflict',
			message: messageOf(b, 'The file changed on disk'),
			currentHash: b?.currentHash
		};
	}
	const b = body as Partial<ApplyFailure> | null;
	if (b && Array.isArray(b.diagnostics))
		return { kind: 'refused', message: messageOf(b, `Refused (${res.status})`), diagnostics: b.diagnostics };
	return { kind: 'failed', message: messageOf(b, `The server answered ${res.status}`) };
}

export async function validateText(
	text: string,
	f: Fetch = fetch
): Promise<{ ok: boolean; diagnostics: Diagnostic[] } | { ok: null; message: string }> {
	try {
		const res = await f('/api/caddyfile/validate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text })
		});
		const body = await readJson(res);
		if (res.ok) return body as ValidateResult;
		const b = body as Partial<ApplyFailure> | null;
		if (b && Array.isArray(b.diagnostics)) return { ok: false, diagnostics: b.diagnostics };
		return { ok: null, message: messageOf(b, `The server answered ${res.status}`) };
	} catch (err) {
		return { ok: null, message: `Could not reach the UI server: ${String(err)}` };
	}
}

export async function loadDocument(f: Fetch = fetch): Promise<CaddyfileDoc> {
	const res = await f('/api/caddyfile');
	if (!res.ok) throw new Error(messageOf(await readJson(res), `The server answered ${res.status}`));
	return (await res.json()) as CaddyfileDoc;
}

export async function loadSchema(f: Fetch = fetch): Promise<SchemaBundle> {
	const res = await f('/api/schema');
	if (!res.ok) throw new Error(`The schema did not load (${res.status})`);
	return (await res.json()) as SchemaBundle;
}

/**
 * Caddy's findings (`/adapt`, `/load`, service errors) placed on the text. Parser and schema findings are
 * left out because the editor already computes them locally on every change.
 */
export function caddyDiagnostics(text: string, diags: readonly Diagnostic[]): EditorDiagnostic[] {
	return placeLineDiagnostics(
		text,
		diags.filter((d) => d.source !== 'parser' && d.source !== 'schema')
	);
}

/** Unsaved edits kept in this browser, tied to the version of the file they started from. */
export type Draft = { baseHash: string; text: string; savedAt: number };
export const DRAFT_KEY = 'caddy-ui:editor-draft';

export function readDraft(storage: Pick<Storage, 'getItem'> | undefined): Draft | null {
	try {
		const raw = storage?.getItem(DRAFT_KEY);
		if (!raw) return null;
		const d = JSON.parse(raw) as Partial<Draft>;
		return typeof d.baseHash === 'string' && typeof d.text === 'string'
			? { baseHash: d.baseHash, text: d.text, savedAt: Number(d.savedAt) || 0 }
			: null;
	} catch {
		return null;
	}
}

export function writeDraft(
	storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
	draft: Draft | null
) {
	try {
		if (!storage) return;
		if (draft) storage.setItem(DRAFT_KEY, JSON.stringify(draft));
		else storage.removeItem(DRAFT_KEY);
	} catch {
		/* storage full or blocked: drafts are a convenience only */
	}
}
