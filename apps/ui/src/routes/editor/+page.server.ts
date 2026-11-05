import { getConfigService } from '$lib/server/config';
import type { PageServerLoad } from './$types';

/** The file as it is on disk now, with its hash for the conflict check and the drift state. */
export const load: PageServerLoad = async () => {
	const doc = await getConfigService().document();
	return {
		doc: {
			path: doc.path,
			exists: doc.exists,
			text: doc.text,
			hash: doc.hash,
			parser: doc.parser,
			drift: doc.drift,
			externalChange: doc.externalChange
		}
	};
};
