import type { DryRun } from '$lib/api/porkbun';
import type { RestoreRehearsal } from '$lib/porkbun/registry/types';
import { authorOf } from '$lib/server/config/http';
import {
	PorkbunError,
	porkbun,
	requireDomain,
	requireWritable,
	toApiError,
	toResponse,
	write
} from '$lib/server/porkbun';
import { badRequest, body, fresh, requireConfirm, written } from '$lib/server/porkbun-registry/http';
import { restorePointId } from '$lib/server/porkbun-registry/params';
import type { RequestHandler } from './$types';

/**
 * Restore the zone to a restore point. Body: `{ prune?: boolean, dryRun?: boolean, confirm?: string }`.
 *
 * - `dryRun: true` asks Porkbun what would happen and changes nothing (`RestoreRehearsal`).
 * - Otherwise the restore is sent through `write()` (`WriteResult<RestoreResult>`). Porkbun saves the state
 *   from just before as a new restore point, `previousStateSavedAs`; restoring that one with `prune` undoes
 *   this restore.
 * - `prune` also deletes records added since the restore point, so it needs the domain name typed.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const id = restorePointId(params.id);
		if (id === null) return badRequest('A restore point id is a whole number');
		const input = await body(request);
		if (!input) return badRequest('Send a JSON object');
		if (input.prune !== undefined && typeof input.prune !== 'boolean') {
			return badRequest('"prune" is true or false');
		}
		const prune = input.prune === true;
		const pb = porkbun();

		if (input.dryRun === true) {
			requireWritable('dns');
			let out: RestoreRehearsal;
			try {
				const {
					warnings,
					requestId: _,
					...result
				} = await pb.dns.restore(domain, id, {
					prune,
					dryRun: true
				});
				out = { dryRun: { wouldSucceed: true, warnings }, result };
			} catch (err) {
				if (!(err instanceof PorkbunError) || err.retryable) throw err;
				const dryRun: DryRun = { wouldSucceed: false, warnings: [], error: toApiError(err) ?? undefined };
				out = { dryRun, result: null };
			}
			return fresh(out);
		}

		if (prune) {
			const refused = requireConfirm(input, domain, 'a restore that deletes records');
			if (refused) return refused;
		}
		// What the restore will change, as Porkbun sees it now: the "before" of the write log.
		const before = await pb.dns.diff(domain, id);
		const result = await write({
			scope: 'dns',
			author: authorOf(locals),
			domain,
			action: 'dns.restore',
			request: { snapshotId: id, prune },
			before,
			run: (client) => client.dns.restore(domain, id, { prune })
		});
		return written(result);
	} catch (err) {
		return toResponse(err);
	}
};
