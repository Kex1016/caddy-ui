import http from 'node:http';
import https from 'node:https';

/**
 * `fetch` for Caddy's admin API, sent with node:http instead of Node's built-in fetch.
 *
 * Node's fetch (undici) always adds `Sec-Fetch-Mode: cors`. Since Caddy 2.11 the admin API treats any request
 * carrying Sec-Fetch-Mode as a browser request and enforces its origin list, which only holds the listen address
 * (`//0.0.0.0:2019`), so every call from the UI got `403 client is not allowed to access from origin ''`.
 * Plain node:http sends only the headers we set, like curl does.
 */
export const adminFetch: typeof fetch = (input, init = {}) =>
	new Promise<Response>((resolve, reject) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
		const headers = new Headers(init.headers);
		const body = init.body === undefined || init.body === null ? undefined : String(init.body);
		if (body !== undefined && !headers.has('content-length')) {
			headers.set('content-length', String(Buffer.byteLength(body)));
		}
		const signal = init.signal ?? undefined;
		if (signal?.aborted) return reject(signal.reason);
		const req = (url.protocol === 'https:' ? https : http).request(
			url,
			{ method: init.method ?? 'GET', headers: Object.fromEntries(headers) },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('error', reject);
				res.on('end', () => {
					const h = new Headers();
					for (const [k, v] of Object.entries(res.headers)) {
						if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
					}
					const status = res.statusCode ?? 502;
					const noBody = status === 204 || status === 304;
					resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: h }));
				});
			}
		);
		const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
		signal?.addEventListener('abort', onAbort, { once: true });
		req.on('error', reject);
		req.on('close', () => signal?.removeEventListener('abort', onAbort));
		req.end(body);
	});
