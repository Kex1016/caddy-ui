import { isHttpError } from '@sveltejs/kit';
import type { Cached, DnssecRecord, GlueHost } from '$lib/api/porkbun';
import type { Part } from '$lib/porkbun/registry/types';
import { cached, isConfigured, porkbun, requireDomain, toApiError } from '$lib/server/porkbun';
import type { PageServerLoad } from './$types';

async function part<T>(load: () => Promise<Cached<T>>): Promise<Part<T>> {
	try {
		return { value: await load(), error: null };
	} catch (err) {
		const error = toApiError(err);
		if (!error) throw err;
		return { value: null, error };
	}
}

const none = { value: null, error: null };

/** The Registry tab: nameservers, glue records and DS records, as the registry has them. */
export const load: PageServerLoad = async ({
	params
}): Promise<{ ns: Part<string[]>; glue: Part<GlueHost[]>; dnssec: Part<DnssecRecord[]> }> => {
	// The layouts redirect when the keys are unset and show the error when the domain is not in the account.
	if (!isConfigured()) return { ns: none, glue: none, dnssec: none };
	let domain: string;
	try {
		domain = (await requireDomain(params.domain)).domain;
	} catch (err) {
		if (isHttpError(err) || toApiError(err)) return { ns: none, glue: none, dnssec: none };
		throw err;
	}
	const pb = porkbun();
	const [ns, glue, dnssec] = await Promise.all([
		part(() => cached(`${domain}:ns`, () => pb.ns.get(domain))),
		part(() => cached(`${domain}:glue`, () => pb.glue.list(domain))),
		part(() => cached(`${domain}:dnssec`, () => pb.dnssec.list(domain)))
	]);
	return { ns, glue, dnssec };
};
