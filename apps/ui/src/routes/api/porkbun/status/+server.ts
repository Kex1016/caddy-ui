import { json } from '@sveltejs/kit';
import { porkbunStatus } from '$lib/server/porkbun';
import type { RequestHandler } from './$types';

/**
 * `PorkbunStatus`: whether the keys are set and accepted, what the key may do, read-only mode, the sandbox
 * flag and this server's public IP as Porkbun sees it. Always 200. With the keys unset no call is made.
 * `?force` asks Porkbun again now.
 */
export const GET: RequestHandler = async ({ url }) =>
	json(await porkbunStatus({ force: url.searchParams.has('force') }), {
		headers: { 'cache-control': 'no-store' }
	});
