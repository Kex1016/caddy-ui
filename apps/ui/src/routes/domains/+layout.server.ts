import { redirect } from '@sveltejs/kit';
import { porkbunStatus } from '$lib/server/porkbun';
import type { LayoutServerLoad } from './$types';

/**
 * Every Domains page gets `data.porkbun` (`PorkbunStatus`). With the keys unset or half set, `/domains`
 * itself explains the set-up and every page below it leads back there, so no page under this layout has to
 * render without a client. (A page's own load still runs alongside this one: see the README in
 * `$lib/server/porkbun` for the guard it needs.)
 */
export const load: LayoutServerLoad = async ({ url }) => {
	const porkbun = await porkbunStatus();
	const unset = porkbun.state === 'off' || porkbun.state === 'misconfigured';
	if (unset && url.pathname !== '/domains') redirect(303, '/domains');
	return { porkbun };
};
