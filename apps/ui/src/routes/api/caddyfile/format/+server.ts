import { json } from '@sveltejs/kit';
import { failure, noStore, readTextBody } from '$lib/server/config/http';
import { getParser } from '$lib/server/config/parser';
import type { RequestHandler } from './$types';

/** `caddy fmt` style formatting from the parser package; 501 until that package is installed. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const { text } = await readTextBody(request);
		const parser = getParser();
		if (!parser) {
			return json(
				{ message: 'Formatting arrives with the Caddyfile parser package', code: 'not_available' },
				{ status: 501 }
			);
		}
		return json({ text: parser.format(text) }, { headers: noStore });
	} catch (err) {
		return failure(err);
	}
};
