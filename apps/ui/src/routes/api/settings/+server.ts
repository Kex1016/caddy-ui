import { json } from '@sveltejs/kit';
import type { SettingsError, SettingsPatch } from '$lib/api/settings';
import { authorOf, noStore } from '$lib/server/config/http';
import { getSettings, SettingsRefused } from '$lib/server/settings';
import type { RequestHandler } from './$types';

/**
 * Every setting with its value in force, where it came from (saved, env or default), the environment's
 * value and whether the UI can change it. Secrets are reported only as set or unset (plan §2.2, D7–D11).
 */
export const GET: RequestHandler = () => json(getSettings().view(), { headers: noStore });

/**
 * `{ "<VARIABLE>": "<value>" | null, ... }`: save values (null removes the saved value, so the environment or
 * the default applies again). Checked together and saved together; applied at once, without a restart.
 */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		const err: SettingsError = {
			message: 'Send a JSON object such as {"CADDY_UI_PROBE_INTERVAL": "1m"}',
			code: 'INVALID'
		};
		return json(err, { status: 400, headers: noStore });
	}
	try {
		return json(getSettings().update(body as SettingsPatch, authorOf(locals)), { headers: noStore });
	} catch (err) {
		if (err instanceof SettingsRefused) return json(err.body, { status: err.status, headers: noStore });
		throw err;
	}
};
