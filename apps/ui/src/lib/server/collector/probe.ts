import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { ProbeTarget, UpstreamTarget } from './sites';

export type ProbeResult = {
	ok: boolean;
	latencyMs: number | null;
	status: number | null;
	error: string | null;
};

const MAX_REDIRECTS = 5;

/**
 * A response means the site is up unless Caddy says it could not reach what is behind it. 502, 503 and 504
 * are what `reverse_proxy` answers when every upstream is down; anything else (including 401 or a redirect
 * to a sign-in page) shows that Caddy and the site's handler answered.
 */
export function statusIsUp(status: number): boolean {
	return !(status === 502 || status === 503 || status === 504);
}

function request(
	target: ProbeTarget,
	method: string,
	timeoutMs: number
): Promise<{ status: number; location?: string }> {
	return new Promise((resolve, reject) => {
		const u = new URL(target.url);
		const lib = u.protocol === 'https:' ? https : http;
		const req = lib.request(
			u,
			{
				method,
				headers: {
					...(target.hostHeader ? { host: target.hostHeader } : {}),
					'user-agent': 'caddy-ui-probe/1',
					accept: '*/*'
				},
				servername: target.servername,
				// Reachability only; certificate expiry is reported separately from Caddy's data directory, and
				// sites on `localhost` or internal CAs would otherwise always look down.
				rejectUnauthorized: false,
				timeout: timeoutMs,
				agent: false
			},
			(res) => {
				res.resume();
				resolve({ status: res.statusCode ?? 0, location: res.headers.location });
			}
		);
		req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs / 1000}s`)));
		req.on('error', reject);
		req.end();
	});
}

function describe(err: unknown): string {
	if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
		const msg = 'message' in err && typeof err.message === 'string' ? err.message : '';
		return msg.includes(err.code) ? msg : `${err.code}: ${msg}`;
	}
	return err instanceof Error ? err.message : String(err);
}

/**
 * GETs a site through Caddy, following redirects that stay on the same host. `alsoUp` are statuses that count as
 * up on top of `statusIsUp` (a per-site probe option, for example 503 for a maintenance page).
 */
export async function probeSite(
	target: ProbeTarget,
	timeoutMs: number,
	alsoUp: readonly number[] = []
): Promise<ProbeResult> {
	const started = performance.now();
	let current = target;
	try {
		for (let hop = 0; ; hop++) {
			const { status, location } = await request(current, 'GET', timeoutMs);
			const latencyMs = Math.round((performance.now() - started) * 10) / 10;
			if (status >= 300 && status < 400 && location && hop < MAX_REDIRECTS) {
				const base = new URL(current.url);
				const virtualBase = new URL(current.url);
				if (current.hostHeader) virtualBase.host = current.hostHeader;
				const next = new URL(location, virtualBase);
				// Only follow within the same site; a redirect elsewhere (a sign-in page) already proves it answered.
				if (next.hostname === virtualBase.hostname) {
					const connect = new URL(next.pathname + next.search, base);
					connect.protocol = next.protocol;
					if (next.protocol !== base.protocol) connect.port = next.port;
					current = {
						...current,
						url: connect.toString(),
						servername: next.protocol === 'https:' ? next.hostname : undefined
					};
					if (current.hostHeader) current.hostHeader = next.host;
					continue;
				}
			}
			const ok = statusIsUp(status) || alsoUp.includes(status);
			return { ok, latencyMs, status, error: ok ? null : `HTTP ${status}` };
		}
	} catch (err) {
		return { ok: false, latencyMs: null, status: null, error: describe(err) };
	}
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const sock = net.connect({ host, port });
		const done = (err?: Error) => {
			sock.destroy();
			if (err) reject(err);
			else resolve();
		};
		sock.setTimeout(timeoutMs, () => done(new Error(`no answer within ${timeoutMs / 1000}s`)));
		sock.once('connect', () => done());
		sock.once('error', (e) => done(e));
	});
}

/** TCP connect to an upstream, then a HEAD when its scheme is known. Any HTTP answer counts as up. */
export async function probeUpstream(target: UpstreamTarget, timeoutMs: number): Promise<ProbeResult> {
	const started = performance.now();
	try {
		await tcpConnect(target.host, target.port, timeoutMs);
		let status: number | null = null;
		if (target.scheme) {
			const host = target.host.includes(':') ? `[${target.host}]` : target.host;
			const res = await request({ url: `${target.scheme}://${host}:${target.port}/` }, 'HEAD', timeoutMs);
			status = res.status;
		}
		const latencyMs = Math.round((performance.now() - started) * 10) / 10;
		return { ok: true, latencyMs, status, error: null };
	} catch (err) {
		return { ok: false, latencyMs: null, status: null, error: describe(err) };
	}
}
