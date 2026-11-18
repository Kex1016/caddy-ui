import type { ApiError, PorkbunStatus } from '$lib/api/porkbun';
import type { CaddyTieIn, SiteDnsCheck } from '$lib/api/porkbun-caddy';
import { getStatus, getTieIn } from './api';

/**
 * The tie-in as the Sites pages hold it: asked for after the page has rendered, so the list never waits for
 * Porkbun, and kept while it is asked again, so a column does not blink after every change.
 */
export class TieInState {
	tie = $state<CaddyTieIn | null>(null);
	status = $state<PorkbunStatus | null>(null);
	error = $state<ApiError | null>(null);
	loading = $state(false);
	#run = 0;

	/** What `ScopeGate` needs. Until the status is known nothing is offered. */
	get gate(): Pick<PorkbunStatus, 'state' | 'readonly' | 'scopes'> {
		return this.status ?? { state: 'off', readonly: true, scopes: [] };
	}

	/** The checks of one site block, in the order of its addresses. */
	of(siteId: string): SiteDnsCheck[] {
		return this.tie?.sites.filter((s) => s.siteId === siteId) ?? [];
	}

	async load(opts: { force?: boolean } = {}): Promise<void> {
		const run = ++this.#run;
		this.loading = true;
		const [tie, status] = await Promise.all([getTieIn(opts), this.status ? null : getStatus()]);
		if (run !== this.#run) return;
		this.loading = false;
		if (status?.ok) this.status = status.data;
		if (tie.ok) {
			this.tie = tie.data;
			this.error = tie.data.error ?? null;
		} else {
			this.error = tie.error;
		}
	}
}

/** The check that matters most for a row with several addresses: problems first. */
const ORDER: SiteDnsCheck['status'][] = [
	'wrong',
	'missing',
	'unreadable',
	'elsewhere',
	'private',
	'external',
	'unverified',
	'ok',
	'not_porkbun'
];
export function worst(checks: readonly SiteDnsCheck[]): SiteDnsCheck | null {
	let found: SiteDnsCheck | null = null;
	for (const c of checks) {
		if (!found || ORDER.indexOf(c.status) < ORDER.indexOf(found.status)) found = c;
	}
	return found;
}
