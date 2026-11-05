import { json } from '@sveltejs/kit';
import { getRuntime } from '$lib/server/runtime';
import { UI_VERSION } from '$lib/server/version';
import type { RequestHandler } from './$types';

/** Unauthenticated liveness for the compose healthcheck and the updater (PLAN.md §3.2). */
export const GET: RequestHandler = () => {
	const { startedAt } = getRuntime();
	return json(
		{ status: 'ok', version: UI_VERSION, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
