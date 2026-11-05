import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Signed, stateless session cookies: `base64url(json).base64url(hmac-sha256)`. */
export type Session = { user: string; exp: number };

export const SESSION_COOKIE = 'caddy_ui_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function makeSecret(configured: string | undefined): Buffer {
	// A configured secret keeps sessions valid across restarts; otherwise every boot logs everyone out.
	return configured ? Buffer.from(configured, 'utf8') : randomBytes(32);
}

function sign(secret: Buffer, data: string): string {
	return createHmac('sha256', secret).update(data).digest('base64url');
}

export function encodeSession(secret: Buffer, session: Session): string {
	const body = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
	return `${body}.${sign(secret, body)}`;
}

export function decodeSession(secret: Buffer, token: string | undefined, now = Date.now()): Session | null {
	if (!token) return null;
	const dot = token.indexOf('.');
	if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
	const body = token.slice(0, dot);
	const mac = Buffer.from(token.slice(dot + 1), 'base64url');
	const expected = Buffer.from(sign(secret, body), 'base64url');
	if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
	try {
		const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			typeof (parsed as Session).user !== 'string' ||
			typeof (parsed as Session).exp !== 'number'
		) {
			return null;
		}
		const session = parsed as Session;
		return session.exp > now ? { user: session.user, exp: session.exp } : null;
	} catch {
		return null;
	}
}
