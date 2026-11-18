import { json } from '@sveltejs/kit';
import { authorOf } from '$lib/server/config/http';
import { cached, porkbun, requireDomain, toResponse, write } from '$lib/server/porkbun';
import { refuse as badRequest } from '$lib/server/porkbun-http';
import { checkForward } from '$lib/porkbun/forwarding/forwards';
import type { RequestHandler } from './$types';

const noStore = { 'cache-control': 'no-store' };

/** The URL forwards of a domain (`Cached<UrlForward[]>`). `?force` asks Porkbun again. */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const domain = await requireDomain(params.domain);
		const forwards = await cached(`${domain.domain}:forwards`, () => porkbun().forwards.list(domain.domain), {
			force: url.searchParams.has('force')
		});
		return json(forwards, { headers: noStore });
	} catch (err) {
		return toResponse(err);
	}
};

/** Add a forward. Body: `UrlForwardInput`. Answers `WriteResult`. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return badRequest('The body must be JSON.');
		}
		const checked = checkForward(raw);
		if (!checked.ok) return badRequest(checked.message);
		const input = checked.value;

		const current = await cached(`${domain.domain}:forwards`, () => porkbun().forwards.list(domain.domain), {
			force: true
		});
		const twin = current.data.find((f) => f.subdomain === input.subdomain);
		if (twin) {
			return badRequest(
				`${input.subdomain ? `${input.subdomain}.${domain.domain}` : domain.domain} already forwards to ${twin.location}. Delete that forward first.`,
				409,
				'DUPLICATE_FORWARD'
			);
		}

		const result = await write({
			scope: 'dns',
			author: authorOf(locals),
			domain: domain.domain,
			action: 'forward.add',
			request: input,
			before: current.data,
			run: (pb) => pb.forwards.add(domain.domain, input)
		});
		return json(result, { status: result.ok ? 200 : 502, headers: noStore });
	} catch (err) {
		return toResponse(err);
	}
};
