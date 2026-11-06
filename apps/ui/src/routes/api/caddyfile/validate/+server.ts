import { json } from '@sveltejs/kit';
import { getConfigService } from '$lib/server/config';
import { failure, noStore, readTextBody } from '$lib/server/config/http';
import type { ValidateResult } from '$lib/api/config';
import type { RequestHandler } from './$types';

/** Dry run: parser diagnostics plus Caddy's `/adapt`, nothing written or loaded. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const { text } = await readTextBody(request);
		const { ok, diagnostics } = await getConfigService().validate(text);
		return json({ ok, diagnostics } satisfies ValidateResult, { headers: noStore });
	} catch (err) {
		return failure(err);
	}
};
