import { fail, redirect } from '@sveltejs/kit';
import { checkCredentials, safeRedirect } from '$lib/server/auth';
import { config } from '$lib/server/env';
import { isHttps } from '$lib/server/guard';
import { getRuntime } from '$lib/server/runtime';
import { SESSION_COOKIE, SESSION_TTL_MS, encodeSession } from '$lib/server/session';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.identity) redirect(303, safeRedirect(url.searchParams.get('next')));
	const { auth } = getRuntime();
	return {
		mode: auth.mode,
		missing: auth.mode === 'local-misconfigured' ? auth.missing : null
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		const { auth, secret, limiter } = getRuntime();
		if (auth.mode !== 'local') return fail(400, { message: 'Sign-in with a password is not enabled.' });

		const client = getClientAddress();
		const wait = limiter.retryAfter(client);
		if (wait > 0) {
			const minutes = Math.ceil(wait / 60_000);
			return fail(429, {
				message: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
			});
		}

		const form = await request.formData();
		const user = String(form.get('user') ?? '');
		const password = String(form.get('password') ?? '');
		if (!checkCredentials(auth, user, password)) {
			limiter.fail(client);
			return fail(400, { message: 'That username and password do not match.', user });
		}

		limiter.succeed(client);
		const exp = Date.now() + SESSION_TTL_MS;
		cookies.set(SESSION_COOKIE, encodeSession(secret, { user, exp }), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: isHttps(request.headers, config().publicUrl),
			expires: new Date(exp)
		});
		redirect(303, safeRedirect(url.searchParams.get('next')));
	}
};
