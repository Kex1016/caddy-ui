import type { PreflightIntent } from '$lib/api/porkbun';

/** Route parameters of the P3 routes. */

export const PREFLIGHT_INTENTS: readonly PreflightIntent[] = [
	'general',
	'move-nameservers',
	'transfer-out',
	'enable-dnssec'
];

/** A restore point id from the path, or null when it is not a positive whole number. */
export function restorePointId(raw: string): number | null {
	return /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
}
