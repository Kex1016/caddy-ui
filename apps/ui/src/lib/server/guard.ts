/** Pure request-routing decisions used by hooks.server.ts, kept separate so they are unit-tested. */

const PUBLIC_PATHS = new Set(['/api/health', '/login']);

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PATHS.has(pathname) || pathname.startsWith('/_app/') || pathname === '/favicon.svg';
}

export function isApiPath(pathname: string): boolean {
	return pathname === '/api' || pathname.startsWith('/api/');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF check for state-changing requests: the browser-set Origin header must name the host the request was
 * sent to. The scheme is not compared, so the check holds both behind Caddy (https) and on a plain http
 * port. Requests without an Origin header (curl, the updater) are allowed: browsers always send Origin on
 * cross-site POST, PUT, PATCH and DELETE.
 */
export function sameOrigin(method: string, headers: Headers): boolean {
	if (SAFE_METHODS.has(method.toUpperCase())) return true;
	const origin = headers.get('origin');
	if (origin === null) return true;
	if (origin === 'null') return false;
	let originHost: string;
	try {
		originHost = new URL(origin).host.toLowerCase();
	} catch {
		return false;
	}
	const hosts = [headers.get('x-forwarded-host'), headers.get('host')]
		.flatMap((h) => (h ? h.split(',') : []))
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
	return hosts.includes(originHost);
}

/**
 * Whether the browser reached us over https. The Node server itself only speaks http, so this is true only
 * when the proxy in front says so (Caddy sets X-Forwarded-Proto) or CADDY_UI_PUBLIC_URL is https. Used to
 * mark cookies Secure without breaking sign-in on a plain http port.
 */
export function isHttps(headers: Headers, publicUrl: string | undefined): boolean {
	const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
	if (forwarded) return forwarded === 'https';
	return publicUrl?.startsWith('https://') ?? false;
}
