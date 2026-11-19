import { json } from '@sveltejs/kit';
import { authorOf } from '$lib/server/config/http';
import { requireDomain } from '$lib/server/porkbun';
import {
	MAX_IMPORT_BYTES,
	importRecords,
	parseImportBody,
	readJson,
	respond
} from '$lib/porkbun/records/service.server';
import type { RequestHandler } from './$types';

/**
 * Import records (`ImportReview`). The body names one source and whether this is the rehearsal:
 *
 * - `{ text, dryRun? }`: a pasted BIND zone file, or JSON (a list of records, or an object with `records`).
 * - `{ records, dryRun? }`: records as JSON objects, for example the ones a scan found.
 * - `{ scan: true, dryRun: true }`: "discover records": what the domain's current nameservers publish. A scan
 *   only looks; to import what it found, send those records back.
 *
 * With `dryRun` nothing changes: every record is sorted into new, already there, in conflict, left out or
 * invalid, and Porkbun rehearses the import of the new ones. Without it the new ones are created. An import
 * only ever adds records. The answer is 200 when everything went through and 207 when part of it did not.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		const input = parseImportBody(await readJson(request, { maxBytes: MAX_IMPORT_BYTES }));
		const review = await importRecords(domain.domain, input, authorOf(locals));
		return json(review, { status: review.ok ? 200 : 207, headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return respond(err);
	}
};
