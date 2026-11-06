import { schema, schemaVersion } from '@caddy-ui/caddy-schema';
import type { RequestHandler } from './$types';

const body = JSON.stringify(schema);
const etag = `"schema-${schemaVersion}"`;

/** The schema bundle for the editors (PLAN.md §3.2). Versioned by the schema and docs commit, so it caches. */
export const GET: RequestHandler = ({ request }) => {
	const headers = {
		'content-type': 'application/json',
		etag,
		'cache-control': 'private, max-age=3600, must-revalidate',
		'x-schema-version': schemaVersion
	};
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
	return new Response(body, { headers });
};
