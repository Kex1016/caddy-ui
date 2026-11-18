import { fixSiteRecord, parseFixRequest } from '$lib/server/caddy/porkbun/actions';
import { authorOf } from '$lib/server/config/http';
import { failure, ok, readJson } from '../respond';
import type { RequestHandler } from './$types';

/**
 * Create or fix the record a site needs (docs/porkbun-plan.md §4). Body: `RecordFixRequest`.
 *
 * The server decides the change: an A (or AAAA) record for the site's name with this server's public IP, or
 * that content on the one record that points elsewhere. `dryRun: true` answers `RecordFixPreview` (Porkbun
 * validated it, nothing changed); otherwise `RecordFixResult`, 200 when Porkbun accepted the write and 502
 * when it refused. `expect` is the fix the person reviewed: a 409 with the new fix when the records changed.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const req = parseFixRequest(await readJson(request));
		const done = await fixSiteRecord(req, authorOf(locals));
		return ok(done, 'result' in done && !done.result.ok ? 502 : 200);
	} catch (err) {
		return failure(err);
	}
};
