import { json } from '@sveltejs/kit';
import { getConfigService } from '$lib/server/config';
import { noStore } from '$lib/server/config/http';
import type { RequestHandler } from './$types';

/** Caddy version and uptime (from its metrics), config hash, admin reachability, drift. Always 200. */
export const GET: RequestHandler = async () => json(await getConfigService().status(), { headers: noStore });
