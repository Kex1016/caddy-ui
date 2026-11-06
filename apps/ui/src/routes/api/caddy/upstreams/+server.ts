import { json } from '@sveltejs/kit';
import { getConfigService } from '$lib/server/config';
import { failure, noStore } from '$lib/server/config/http';
import type { RequestHandler } from './$types';

/** `/reverse_proxy/upstreams` with the hosts of the site blocks that proxy to each upstream. */
export const GET: RequestHandler = async () => {
	try {
		return json({ upstreams: await getConfigService().upstreams() }, { headers: noStore });
	} catch (err) {
		return failure(err);
	}
};
