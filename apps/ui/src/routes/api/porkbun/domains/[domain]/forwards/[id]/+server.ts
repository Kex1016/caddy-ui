import { json } from '@sveltejs/kit';
import { isForwardId } from '$lib/porkbun/forwarding/forwards';
import { authorOf } from '$lib/server/config/http';
import { cached, porkbun, requireDomain, toResponse, write } from '$lib/server/porkbun';
import { refuse as badRequest } from '$lib/server/porkbun-http';
import type { RequestHandler } from './$types';

/** Delete one forward. Answers `WriteResult`. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		if (!isForwardId(params.id)) return badRequest('That is not a forward id.');

		const current = await cached(`${domain.domain}:forwards`, () => porkbun().forwards.list(domain.domain), {
			force: true
		});
		const forward = current.data.find((f) => f.id === params.id);
		if (!forward) return badRequest('There is no such forward on this domain.', 404, 'FORWARD_NOT_FOUND');

		const result = await write({
			scope: 'dns',
			author: authorOf(locals),
			domain: domain.domain,
			action: 'forward.delete',
			request: { id: forward.id },
			before: forward,
			run: (pb) => pb.forwards.delete(domain.domain, forward.id)
		});
		return json(result, { status: result.ok ? 200 : 502, headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return toResponse(err);
	}
};
