import { getConfigService } from '$lib/server/config';
import { scanBlocks } from '$lib/server/sites/blocks';
import type { PageServerLoad } from './$types';

/**
 * The file as it is on disk now, with its hash for the conflict check and the drift state, plus the
 * line each site block starts on so `?site=<id>` links from the Sites and stats pages land on it.
 */
export const load: PageServerLoad = async ({ url }) => {
	const doc = await getConfigService().document();
	const scan = scanBlocks(doc.text);
	const mode = url.searchParams.get('mode') === 'text' ? 'text' : 'visual';
	return {
		doc: {
			path: doc.path,
			exists: doc.exists,
			text: doc.text,
			hash: doc.hash,
			parser: doc.parser,
			drift: doc.drift,
			externalChange: doc.externalChange
		},
		sites: scan.blocks
			.filter((b) => b.kind === 'site' && b.id)
			.map((b) => ({ id: b.id as string, line: b.line })),
		mode
	} as const;
};
