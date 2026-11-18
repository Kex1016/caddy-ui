import { checkGlueHost, checkGlueIps } from '$lib/porkbun/registry/validate';
import { authorOf } from '$lib/server/config/http';
import { cached, porkbun, requireDomain, toResponse, write } from '$lib/server/porkbun';
import { badRequest, body, forced, fresh, written } from '$lib/server/porkbun-registry/http';
import type { RequestHandler } from './$types';

/** Glue records: the addresses the registry publishes for nameservers inside the domain (`Cached<GlueHost[]>`). */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const pb = porkbun();
		return fresh(await cached(`${domain}:glue`, () => pb.glue.list(domain), { force: forced(url) }));
	} catch (err) {
		return toResponse(err);
	}
};

/** Add a glue host. Body: `{ host: 'ns1' | 'ns1.example.com', ips: string[] }`. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const input = await body(request);
		if (!input) return badRequest('Send a JSON object');
		const host = checkGlueHost(input.host, domain);
		if (!host.ok) return badRequest(host.message);
		const ips = checkGlueIps(input.ips);
		if (!ips.ok) return badRequest(ips.message);
		return written(
			await write({
				scope: 'domains',
				author: authorOf(locals),
				domain,
				action: 'glue.create',
				request: { host: `${host.value}.${domain}`, ips: ips.value },
				run: (pb) => pb.glue.create(domain, host.value, ips.value)
			})
		);
	} catch (err) {
		return toResponse(err);
	}
};
