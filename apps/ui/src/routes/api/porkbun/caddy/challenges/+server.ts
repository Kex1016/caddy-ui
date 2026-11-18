import { cleanChallenges, parseCleanupRequest } from '$lib/server/caddy/porkbun/actions';
import { authorOf } from '$lib/server/config/http';
import { failure, ok, readJson } from '../respond';
import type { RequestHandler } from './$types';

/**
 * Delete `_acme-challenge` records that Caddy left behind (docs/porkbun-plan.md §4). Body:
 * `ChallengeCleanupRequest`. Only records this UI has seen for more than a day are deleted; each id gets its
 * own result (`ChallengeCleanupResult`), so one refusal does not stop the rest. `dryRun: true` answers
 * `ChallengeCleanupPreview`: Porkbun validated the deletes and nothing was deleted.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const req = parseCleanupRequest(await readJson(request));
		return ok(await cleanChallenges(req, authorOf(locals)));
	} catch (err) {
		return failure(err);
	}
};
