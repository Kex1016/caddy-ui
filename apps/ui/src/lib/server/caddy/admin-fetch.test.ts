import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminFetch } from './admin-fetch';

let server: http.Server;
let base = '';
let seen: http.IncomingHttpHeaders = {};

beforeAll(async () => {
	server = http.createServer((req, res) => {
		seen = req.headers;
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			// Caddy 2.11's admin API: any Sec-Fetch-Mode means a browser, whose origin must be allowed.
			if (req.headers['sec-fetch-mode']) {
				res.statusCode = 403;
				return res.end(JSON.stringify({ error: "client is not allowed to access from origin ''" }));
			}
			if (req.url === '/slow') return setTimeout(() => res.end('late'), 2_000);
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ method: req.method, body }));
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('adminFetch', () => {
	it('does not send Sec-Fetch-Mode, so Caddy 2.11 does not demand an origin', async () => {
		const res = await adminFetch(`${base}/metrics`);
		expect(res.status).toBe(200);
		expect(seen['sec-fetch-mode']).toBeUndefined();
	});
	it('sends method, headers and body and reads the answer', async () => {
		const res = await adminFetch(`${base}/load`, {
			method: 'POST',
			headers: { 'content-type': 'text/caddyfile' },
			body: ':80'
		});
		expect(seen['content-type']).toBe('text/caddyfile');
		expect(await res.json()).toEqual({ method: 'POST', body: ':80' });
	});
	it('honours an abort signal', async () => {
		await expect(adminFetch(`${base}/slow`, { signal: AbortSignal.timeout(50) })).rejects.toBeTruthy();
	});
	it('rejects when nothing listens', async () => {
		await expect(adminFetch('http://127.0.0.1:9/')).rejects.toBeTruthy();
	});
});
