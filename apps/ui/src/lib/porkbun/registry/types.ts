import type { ApiError, Cached, DryRun, Preflight, RestoreResult } from '$lib/api/porkbun';

/**
 * Answers of the P3 routes beyond the shared shapes in `$lib/api/porkbun` (`Cached<T>`, `WriteResult<T>`,
 * `PorkbunFailure`). Client-safe.
 */

/** `POST …/history/:id/restore` with `dryRun: true`: Porkbun's rehearsal, and what it says would happen. */
export type RestoreRehearsal = { dryRun: DryRun; result: RestoreResult | null };

/** `PUT …/nameservers` with `dryRun: true`: Porkbun's rehearsal, and the move-nameservers safety check. */
export type NameserverRehearsal = { dryRun: DryRun; preflight: Preflight };

/** `POST …/dnssec` with `check: true`: the enable-dnssec safety check. Nothing is sent to the registry. */
export type DnssecCheck = { preflight: Preflight };

/** 409 from a nameserver or DNSSEC change that the safety check refuses (docs/porkbun-plan.md §3.1 rule 4). */
export type PreflightBlocked = {
	message: string;
	code: 'PREFLIGHT_BLOCKED';
	error: ApiError;
	preflight: Preflight;
};

/** A section of the Registry tab: its cached data, or why it could not be read. One failing hides no other. */
export type Part<T> = { value: Cached<T> | null; error: ApiError | null };
