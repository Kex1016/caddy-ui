import type { ApiError, AuditEntry } from '$lib/api/porkbun';
import type { DomainOverview } from '$lib/porkbun/domains';
import { loadOverview } from '$lib/porkbun/domains/data.server';
import { auditLog, isConfigured, requireDomain, toApiError } from '$lib/server/porkbun';
import type { PageServerLoad } from './$types';

/**
 * The Overview tab. The `[domain]` layout has already looked the name up (a 404 for one not in the account);
 * when it could not, it shows why in place of this page, so a failure here is handed over, not thrown.
 */
export const load: PageServerLoad = async ({
	params
}): Promise<{
	overview: DomainOverview | null;
	overviewError: ApiError | null;
	recent: AuditEntry[];
	now: number;
}> => {
	const now = Date.now();
	if (!isConfigured()) return { overview: null, overviewError: null, recent: [], now };
	try {
		const domain = await requireDomain(params.domain);
		const overview = await loadOverview(domain);
		const recent = auditLog({ domain: domain.domain, limit: 5 }).entries;
		return { overview, overviewError: null, recent, now };
	} catch (err) {
		const overviewError = toApiError(err);
		if (!overviewError) throw err;
		return { overview: null, overviewError, recent: [], now };
	}
};
