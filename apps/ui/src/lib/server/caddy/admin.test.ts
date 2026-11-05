import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminError, AdminUnreachableError, CaddyAdmin, cleanCaddyError, lineFromCaddyError } from './admin';

/** Answers the way Caddy's admin API does, including its `{"error": "..."}` bodies. */
let server: Server;
let base: string;
const seen: { method: string; url: string; type: string | undefined; body: string }[] = [];

function body(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let s = '';
		req.on('data', (c) => (s += c));
		req.on('end', () => resolve(s));
	});
}

beforeAll(async () => {
	server = createServer(async (req, res) => {
		const text = await body(req);
		seen.push({
			method: req.method ?? '',
			url: req.url ?? '',
			type: req.headers['content-type'],
			body: text
		});
		const send = (status: number, payload: string) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(payload);
		};
		if (req.url === '/config/') return send(200, '{"apps":{"http":{}}}\n');
		if (req.url === '/adapt') {
			if (text.includes('bogus')) {
				return send(
					400,
					JSON.stringify({
						error: 'adapting config using caddyfile: Caddyfile:3: unrecognized directive: bogus'
					})
				);
			}
			return send(
				200,
				JSON.stringify({
					result: { apps: {} },
					warnings: [{ file: 'Caddyfile', line: 2, directive: 'header', message: 'odd' }]
				})
			);
		}
		if (req.url === '/load') {
			return text.includes('fail') ? send(400, '{"error":"loading new config: boom"}') : send(200, '');
		}
		if (req.url === '/reverse_proxy/upstreams')
			return send(200, '[{"address":"a:1","num_requests":0,"fails":1}]');
		if (req.url === '/metrics') return send(200, 'x 1\n');
		if (req.url === '/slow') return setTimeout(() => send(200, '{}'), 500);
		send(404, '{"error":"not found"}');
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('CaddyAdmin', () => {
	it('reads the running config', async () => {
		expect(await new CaddyAdmin(base).getConfig()).toEqual({ apps: { http: {} } });
	});

	it('adapts with the Caddyfile content type and turns warnings into diagnostics', async () => {
		const res = await new CaddyAdmin(base).adapt('a {\n\theader x y\n}\n');
		expect(res).toEqual({
			ok: true,
			config: { apps: {} },
			diagnostics: [{ severity: 'warning', source: 'adapt', message: 'odd', line: 2, directive: 'header' }]
		});
		expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/adapt', type: 'text/caddyfile' });
	});

	it('turns an adapt error into a diagnostic with its line', async () => {
		const res = await new CaddyAdmin(base).adapt('a {\n\nbogus\n}');
		expect(res).toEqual({
			ok: false,
			diagnostics: [{ severity: 'error', source: 'adapt', message: 'unrecognized directive: bogus', line: 3 }]
		});
	});

	it('loads, and reports a refused load with Caddy’s message', async () => {
		await expect(new CaddyAdmin(base).load('ok')).resolves.toBeUndefined();
		await expect(new CaddyAdmin(base).load('fail')).rejects.toEqual(
			new AdminError(400, 'loading new config: boom')
		);
	});

	it('lists upstreams and metrics', async () => {
		const admin = new CaddyAdmin(base);
		expect(await admin.upstreams()).toEqual([{ address: 'a:1', num_requests: 0, fails: 1 }]);
		expect(await admin.metrics()).toBe('x 1\n');
	});

	it('names an unreachable or slow admin API', async () => {
		await expect(new CaddyAdmin('http://127.0.0.1:1').getConfig()).rejects.toBeInstanceOf(
			AdminUnreachableError
		);
		const slow = new CaddyAdmin(base, { timeoutMs: 50 });
		// Reuse the private call path through getConfig on a slow URL.
		const err = await (slow as unknown as { call(m: string, p: string): Promise<Response> })
			.call('GET', '/slow')
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AdminUnreachableError);
		expect((err as Error).message).toMatch(/timed out/);
	});
});

describe('Caddy error text', () => {
	it('finds the line and drops the adapter prefix', () => {
		const msg =
			"adapting config using caddyfile: parsing caddyfile tokens for 'reverse_proxy': Caddyfile:12 - Error during parsing: bad";
		expect(lineFromCaddyError(msg)).toBe(12);
		expect(cleanCaddyError(msg)).toBe(
			"parsing caddyfile tokens for 'reverse_proxy': Caddyfile:12 - Error during parsing: bad"
		);
		expect(lineFromCaddyError('Caddyfile:10 (import tinyauth_forwarder): x')).toBe(10);
		expect(
			cleanCaddyError(
				'adapting config using caddyfile: Caddyfile:22 - Error during parsing: unrecognized directive: x'
			)
		).toBe('unrecognized directive: x');
		expect(lineFromCaddyError('no line here')).toBeUndefined();
	});
});
