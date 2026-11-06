import { getConfigService } from '$lib/server/config';
import type { PageServerLoad } from './$types';

/** The same document the editor gets; the page shows only the non-site blocks of it. */
export const load: PageServerLoad = async ({ url }) => {
	const doc = await getConfigService().document();
	const mode = url.searchParams.get('mode') === 'text' ? 'text' : 'visual';
	return {
		doc: {
			text: doc.text,
			hash: doc.hash,
			parser: doc.parser,
			drift: doc.drift,
			externalChange: doc.externalChange
		},
		mode
	} as const;
};
