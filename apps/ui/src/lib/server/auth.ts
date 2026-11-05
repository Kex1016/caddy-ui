import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthMode, Config } from './env';
import { decodeSession, type Session } from './session';

/**
 * How the UI decides who is asking. Three modes (PLAN.md §3.2, CADDY_UI_AUTH_MODE):
 * - local: username and password from CADDY_UI_USER / CADDY_UI_PASSWORD, signed session cookie.
 *   With both unset local auth is disabled and every request is let in (the shell shows a warning).
 *   With only one of them set the configuration is broken and every request is refused.
 * - forward: a proxy in front (tinyauth via Caddy's forward_auth) has already authenticated the user and
 *   passes the name in the Remote-User header.
 * - none: no authentication, for trusted networks.
 */
export type EffectiveAuth =
	| { mode: 'local'; user: string; password: string }
	| { mode: 'local-disabled' }
	| { mode: 'local-misconfigured'; missing: 'CADDY_UI_USER' | 'CADDY_UI_PASSWORD' }
	| { mode: 'forward' }
	| { mode: 'none' };

export function effectiveAuth(cfg: Pick<Config, 'authMode' | 'user' | 'password'>): EffectiveAuth {
	const mode: AuthMode = cfg.authMode;
	if (mode === 'none') return { mode: 'none' };
	if (mode === 'forward') return { mode: 'forward' };
	if (cfg.user && cfg.password) return { mode: 'local', user: cfg.user, password: cfg.password };
	if (!cfg.user && !cfg.password) return { mode: 'local-disabled' };
	return { mode: 'local-misconfigured', missing: cfg.user ? 'CADDY_UI_PASSWORD' : 'CADDY_UI_USER' };
}

export const FORWARD_USER_HEADER = 'remote-user';

export type Identity = { user: string; via: 'session' | 'forward' | 'open' };

/** Who the request belongs to, or null when it must sign in (local) or is refused (forward, misconfigured). */
export function identify(
	auth: EffectiveAuth,
	secret: Buffer,
	cookie: string | undefined,
	headers: Headers,
	now = Date.now()
): Identity | null {
	switch (auth.mode) {
		case 'none':
		case 'local-disabled':
			return { user: 'admin', via: 'open' };
		case 'local-misconfigured':
			return null;
		case 'forward': {
			const user = headers.get(FORWARD_USER_HEADER)?.trim();
			return user ? { user, via: 'forward' } : null;
		}
		case 'local': {
			const session: Session | null = decodeSession(secret, cookie, now);
			return session && session.user === auth.user ? { user: session.user, via: 'session' } : null;
		}
	}
}

function digest(value: string): Buffer {
	return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of both fields, so timing reveals neither which field was wrong nor its length. */
export function checkCredentials(
	auth: Extract<EffectiveAuth, { mode: 'local' }>,
	user: string,
	password: string
): boolean {
	const userOk = timingSafeEqual(digest(user), digest(auth.user));
	const passOk = timingSafeEqual(digest(password), digest(auth.password));
	return userOk && passOk;
}

/** Sliding-window limit on failed sign-ins per client address. */
export class LoginLimiter {
	private failures = new Map<string, number[]>();

	constructor(
		private readonly max = 10,
		private readonly windowMs = 15 * 60 * 1000
	) {}

	private recent(key: string, now: number): number[] {
		const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
		if (list.length) this.failures.set(key, list);
		else this.failures.delete(key);
		return list;
	}

	/** Milliseconds until the client may try again, or 0 if it may try now. */
	retryAfter(key: string, now = Date.now()): number {
		const list = this.recent(key, now);
		if (list.length < this.max) return 0;
		return this.windowMs - (now - (list[0] as number));
	}

	fail(key: string, now = Date.now()): void {
		const list = this.recent(key, now);
		list.push(now);
		this.failures.set(key, list);
	}

	succeed(key: string): void {
		this.failures.delete(key);
	}
}

/** Only same-site relative paths are allowed as a post-login destination. */
export function safeRedirect(target: string | null | undefined): string {
	if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return '/';
	return target;
}
