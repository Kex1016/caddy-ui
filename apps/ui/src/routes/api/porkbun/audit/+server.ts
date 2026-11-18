import { json } from '@sveltejs/kit';
import { auditLog } from '$lib/server/porkbun';
import type { RequestHandler } from './$types';

/**
 * The write log, newest first (`AuditList`). `?domain=` keeps one domain; `?limit=` (1 to 500, default 100)
 * and `?before=<id>` page through it, with `nextBefore` of one answer as `before` of the next.
 */
export const GET: RequestHandler = ({ url }) => {
	const whole = (name: string): number | undefined | null => {
		const raw = url.searchParams.get(name);
		if (raw === null || raw === '') return undefined;
		return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
	};
	const limit = whole('limit');
	const before = whole('before');
	if (limit === null || before === null || limit === 0) {
		return json(
			{ message: '"limit" and "before" must be whole numbers', code: 'BAD_REQUEST' },
			{ status: 400 }
		);
	}
	const domain = url.searchParams.get('domain')?.trim() || undefined;
	return json(auditLog({ domain, limit, before }), { headers: { 'cache-control': 'no-store' } });
};
