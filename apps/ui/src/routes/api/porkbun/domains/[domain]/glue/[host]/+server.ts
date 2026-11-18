import type { GlueHost } from '$lib/api/porkbun';
import { checkGlueHost, checkGlueIps } from '$lib/porkbun/registry/validate';
import { authorOf } from '$lib/server/config/http';
import { porkbun, requireDomain, toResponse, write } from '$lib/server/porkbun';
import { badRequest, body, refuse, requireConfirm, written } from '$lib/server/porkbun-registry/http';
import type { RequestHandler } from './$types';

async function current(domain: string, host: string): Promise<GlueHost | undefined> {
	const fqdn = `${host}.${domain}`;
	return (await porkbun().glue.list(domain)).find((g) => g.host === fqdn);
}

const notFound = (host: string, domain: string) =>
	refuse(404, 'GLUE_NOT_FOUND', `${host}.${domain} has no glue record`);

/** Replace every address of a glue host. Body: `{ ips: string[] }`. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const host = checkGlueHost(params.host, domain);
		if (!host.ok) return badRequest(host.message);
		const input = await body(request);
		if (!input) return badRequest('Send a JSON object');
		const ips = checkGlueIps(input.ips);
		if (!ips.ok) return badRequest(ips.message);
		const before = await current(domain, host.value);
		if (!before) return notFound(host.value, domain);
		return written(
			await write({
				scope: 'domains',
				author: authorOf(locals),
				domain,
				action: 'glue.update',
				request: { host: before.host, ips: ips.value },
				before,
				run: (pb) => pb.glue.update(domain, host.value, ips.value)
			})
		);
	} catch (err) {
		return toResponse(err);
	}
};

/** Delete a glue host. Body: `{ confirm: '<domain>' }`: the domain name typed. */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	try {
		const { domain } = await requireDomain(params.domain);
		const host = checkGlueHost(params.host, domain);
		if (!host.ok) return badRequest(host.message);
		const input = await body(request);
		if (!input) return badRequest('Send a JSON object');
		const refused = requireConfirm(input, domain, 'deleting the glue record');
		if (refused) return refused;
		const before = await current(domain, host.value);
		if (!before) return notFound(host.value, domain);
		return written(
			await write({
				scope: 'domains',
				author: authorOf(locals),
				domain,
				action: 'glue.delete',
				request: { host: before.host },
				before,
				run: (pb) => pb.glue.delete(domain, host.value)
			})
		);
	} catch (err) {
		return toResponse(err);
	}
};
