import { requireDomain } from '$lib/server/porkbun';
import { readZone, respond } from '$lib/porkbun/records/service.server';
import { toJsonExport, toZoneFile } from '$lib/porkbun/records/zonefile';
import type { RequestHandler } from './$types';

/**
 * The zone as a file to keep: a BIND zone file by default, `?format=json` for JSON. Read from Porkbun at the
 * moment of the export; when Porkbun can not be reached the last good copy is exported and says so in its
 * first lines. Importing the file into an empty zone gives the same records back (notes excepted: a zone
 * file carries them as comments, and an import does not take notes).
 */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const domain = await requireDomain(params.domain);
		const zone = await readZone(domain.domain, { force: true });
		const meta = { at: zone.fetchedAt, stale: zone.stale };
		const asJson = url.searchParams.get('format') === 'json';
		const body = asJson
			? toJsonExport(domain.domain, zone.data.records, meta)
			: toZoneFile(domain.domain, zone.data.records, meta);
		return new Response(body, {
			headers: {
				'content-type': asJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
				'content-disposition': `attachment; filename="${domain.domain}.${asJson ? 'json' : 'zone'}"`,
				'cache-control': 'no-store'
			}
		});
	} catch (err) {
		return respond(err);
	}
};
