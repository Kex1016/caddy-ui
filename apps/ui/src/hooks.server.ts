import { json, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { identify } from '$lib/server/auth';
import { startConfigService } from '$lib/server/config';
import { installCaddyfileParser } from '$lib/server/config/caddyfile-parser';
import { startCollector } from '$lib/server/collector';
import { ConfigError, config } from '$lib/server/env';
import { isApiPath, isPublicPath, sameOrigin } from '$lib/server/guard';
import { reconfigurePorkbun } from '$lib/server/porkbun';
import { getRuntime } from '$lib/server/runtime';
import { installSettings, onSettingsChange } from '$lib/server/settings';
import { SESSION_COOKIE } from '$lib/server/session';
import { THEME_COOKIE, parseTheme, themeAttribute } from '$lib/theme';

function seeOther(location: string): Response {
	return new Response(null, { status: 303, headers: { location } });
}

/**
 * Read and validate the environment once at boot, so a bad variable stops the container with its name. Saved
 * settings are loaded first, so everything after reads the effective config; a bad saved value is only a
 * warning (docs/configuration.md).
 */
export const init: ServerInit = async () => {
	try {
		if (!building) {
			try {
				installSettings();
				onSettingsChange((next) => reconfigurePorkbun(next.porkbun));
			} catch (err) {
				if (err instanceof ConfigError) throw err;
				// Saved settings must never stop the UI: run on the environment and say why.
				console.error(
					`caddy-ui: saved settings could not be read (${err instanceof Error ? err.message : String(err)}); using environment values and defaults`
				);
			}
		}
		const { auth } = getRuntime();
		if (auth.mode === 'local-disabled') {
			console.warn('caddy-ui: CADDY_UI_USER and CADDY_UI_PASSWORD are unset, so local sign-in is off.');
		} else if (auth.mode === 'local-misconfigured') {
			console.error(`caddy-ui: ${auth.missing} is unset; every request is refused until both are set.`);
		}
		const { porkbun } = config();
		if (Boolean(porkbun.apiKey) !== Boolean(porkbun.apiSecret)) {
			const missing = porkbun.apiKey ? 'PORKBUN_API_SECRET_KEY' : 'PORKBUN_API_KEY';
			console.warn(
				`caddy-ui: ${missing} is unset, so the Domains area is off until both Porkbun keys are set.`
			);
		}
		if (!building && process.env.VITEST === undefined) startCollector();
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`caddy-ui: invalid configuration: ${err.message}`);
			process.exit(1);
		}
		throw err;
	}
	installCaddyfileParser();
	await startConfigService();
};

export const handle: Handle = async ({ event, resolve }) => {
	const { url, request, cookies } = event;
	const api = isApiPath(url.pathname);

	if (!sameOrigin(request.method, request.headers)) {
		const message = 'Cross-site request refused';
		return api ? json({ message }, { status: 403 }) : new Response(message, { status: 403 });
	}

	const { auth, secret } = getRuntime();
	event.locals.identity = identify(auth, secret, cookies.get(SESSION_COOKIE), request.headers);
	event.locals.theme = parseTheme(cookies.get(THEME_COOKIE));

	if (!event.locals.identity && !isPublicPath(url.pathname)) {
		if (api) return json({ message: 'Sign in required' }, { status: 401 });
		const next = url.pathname + url.search;
		// In forward mode or with a broken local config the login page explains what is wrong instead.
		return seeOther(
			auth.mode === 'local' && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'
		);
	}

	const response = await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%caddy-ui.theme%', themeAttribute(event.locals.theme))
	});
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('x-frame-options', 'DENY');
	return response;
};

export const handleError: HandleServerError = ({ error, status }) => {
	if (status !== 404) console.error(error);
	return { message: status === 404 ? 'Not found' : 'Something went wrong on the server' };
};
