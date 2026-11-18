import { auditLog } from '$lib/server/porkbun';
import type { PageServerLoad } from './$types';

/** The write log: every change this UI sent to Porkbun, newest first. `?domain=` keeps one domain. */
export const load: PageServerLoad = ({ url }) => {
	const domain = url.searchParams.get('domain')?.trim().toLowerCase() || null;
	const raw = url.searchParams.get('before');
	const before = raw && /^\d{1,15}$/.test(raw) ? Number(raw) : undefined;
	return {
		domain,
		paged: before !== undefined,
		log: auditLog({ domain: domain ?? undefined, before, limit: 50 })
	};
};
