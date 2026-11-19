import { json } from '@sveltejs/kit';
import { MaintenanceRefused } from '$lib/server/settings/maintenance';
import { getMaintenance } from '$lib/server/settings/tools';
import type { RequestHandler } from './$types';

/**
 * `GET /api/settings/backup` (S3, docs/settings-and-perf-plan.md §3, Data and storage): a .tar.gz with a
 * consistent copy of the database (made with `VACUUM INTO` in a worker thread, so probes keep being written) and
 * the Caddyfile. The database holds no environment secret (the Porkbun keys and sign-in secrets are never
 * stored), but it does hold the Caddyfile history and, once S5 is in, the Discord webhook URL; keep the file
 * private. 409 while the database is being compacted, 507 when the volume has no room for the copy.
 */
export const GET: RequestHandler = async () => {
	try {
		const { stream, name } = await getMaintenance().backup();
		return new Response(stream, {
			headers: {
				'content-type': 'application/gzip',
				'content-disposition': `attachment; filename="${name}"`,
				'cache-control': 'no-store'
			}
		});
	} catch (err) {
		if (err instanceof MaintenanceRefused) {
			const status = err.code === 'space' ? 507 : err.code === 'busy' ? 409 : 400;
			return json({ message: err.message }, { status, headers: { 'cache-control': 'no-store' } });
		}
		throw err;
	}
};
