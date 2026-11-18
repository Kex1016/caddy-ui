import { json } from '@sveltejs/kit';
import type { Preflight, PreflightIntent, PorkbunFailure, WriteResult } from '$lib/api/porkbun';
import type { PreflightBlocked } from '$lib/porkbun/registry/types';
import { confirms } from '$lib/porkbun/registry/validate';
import { porkbun } from '$lib/server/porkbun';

/**
 * Small pieces the P3 routes (history, preflight, nameservers, glue, DNSSEC) share. Everything that talks to
 * Porkbun still goes through `$lib/server/porkbun`; this file only shapes requests and answers.
 */

export const NO_STORE = { 'cache-control': 'no-store' } as const;

/** A JSON answer that the browser must not keep: everything here is live account data. */
export function fresh(body: unknown, status = 200): Response {
	return json(body, { status, headers: NO_STORE });
}

/** A request this UI refuses before asking Porkbun anything, in the `PorkbunFailure` shape. */
export function refuse(status: number, code: string, message: string): Response {
	const body: PorkbunFailure = { message, code, error: { code, message, retryable: false } };
	return fresh(body, status);
}

export const badRequest = (message: string): Response => refuse(400, 'BAD_REQUEST', message);

/** The request body as an object, or null when it is not JSON or not an object. An empty body is `{}`. */
export async function body(request: Request): Promise<Record<string, unknown> | null> {
	const text = await request.text();
	if (text.trim() === '') return {};
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Destructive changes carry the domain name the person typed (docs/porkbun-plan.md §3.1 rule 3). The page
 * asks for it; checking it here as well means no other caller can skip the step.
 */
export function requireConfirm(
	input: Record<string, unknown>,
	domain: string,
	what: string
): Response | null {
	if (confirms(input.confirm, domain)) return null;
	return refuse(
		400,
		'CONFIRMATION_REQUIRED',
		`Type the domain name to confirm ${what}: send "confirm": "${domain}" with the request`
	);
}

/** A write's answer: 200 when Porkbun accepted it, 502 when it refused or could not be reached. */
export function written<T>(result: WriteResult<T>): Response {
	return fresh(result, result.ok ? 200 : 502);
}

/**
 * Ask Porkbun's safety check now, never from the cache: it guards a change that can take the domain off the
 * internet. Throws like any read when Porkbun can not be asked, so the change is not made blind.
 */
export function preflightNow(domain: string, intent: PreflightIntent): Promise<Preflight> {
	return porkbun().dns.preflight(domain, intent);
}

/** The failing blocker checks, as "title: detail" lines. */
export function blockerLines(pf: Preflight): string[] {
	return pf.checks
		.filter((c) => !c.ok && c.severity === 'blocker')
		.map((c) => [c.title, c.detail].filter(Boolean).join(': '));
}

/** 409 when the safety check reports a blocker, else null. */
export function blockedBy(pf: Preflight, what: string): Response | null {
	if (pf.blockers.length === 0) return null;
	const lines = blockerLines(pf);
	const message = `Porkbun's safety check refuses ${what}: ${lines.join('; ') || pf.blockers.join(', ')}`;
	const out: PreflightBlocked = {
		message,
		code: 'PREFLIGHT_BLOCKED',
		error: { code: 'PREFLIGHT_BLOCKED', message, retryable: false },
		preflight: pf
	};
	return fresh(out, 409);
}

/** True for `?force`, `?force=1` and `?force=true`: skip the cache and ask Porkbun. */
export function forced(url: URL): boolean {
	const v = url.searchParams.get('force');
	return v !== null && v !== '0' && v !== 'false';
}
