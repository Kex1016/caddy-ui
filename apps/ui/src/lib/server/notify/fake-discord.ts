/**
 * A fake Discord webhook endpoint over HTTP, for the notifier's unit tests and the e2e suite
 * (e2e/support/discord-fake.mjs). No test ever posts to the real Discord: the UI is pointed here with
 * `CADDY_UI_DISCORD_API_URL`. Node 22.18+ loads this file as it is, so it uses only `node:http` and erasable
 * TypeScript.
 *
 * Webhook calls: `POST /api/v10/webhooks/<id>/<token>?wait=true[&with_components=true]`. Control:
 *   GET  /__fake/messages              every message received since the last reset
 *   POST /__fake/reset                 forget messages and behaviour
 *   POST /__fake/refuse-components {on}  answer 400 to Components v2, as a webhook that refuses them would
 *   POST /__fake/respond-next {status, body, headers, times}  canned answers for the next calls
 */
import http from 'node:http';

export type FakeMessage = {
	at: number;
	webhookId: string;
	token: string;
	query: Record<string, string>;
	body: Record<string, unknown>;
};

type Canned = { status: number; body?: unknown; headers?: Record<string, string> };

export type FakeDiscord = {
	url: string;
	port: number;
	messages: FakeMessage[];
	refuseComponents: boolean;
	respondNext: (c: Canned, times?: number) => void;
	reset: () => void;
	close: () => Promise<void>;
};

const COMPONENTS_V2 = 1 << 15;

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
	const text = body === undefined ? '' : JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json', ...headers });
	res.end(text);
}

export function startFakeDiscord(port = 0): Promise<FakeDiscord> {
	const canned: Canned[] = [];
	const state: FakeDiscord = {
		url: '',
		port: 0,
		messages: [],
		refuseComponents: false,
		respondNext: (c, times = 1) => {
			for (let i = 0; i < times; i++) canned.push(c);
		},
		reset: () => {
			state.messages.length = 0;
			state.refuseComponents = false;
			canned.length = 0;
		},
		close: () => new Promise((r) => server.close(() => r()))
	};

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://fake');
		const raw = await readBody(req);
		const route = `${req.method} ${url.pathname}`;
		if (route === 'GET /__fake/messages') return send(res, 200, state.messages);
		if (route === 'POST /__fake/reset') {
			state.reset();
			return send(res, 200, { ok: true });
		}
		if (route === 'POST /__fake/refuse-components') {
			state.refuseComponents = Boolean((JSON.parse(raw || '{}') as { on?: boolean }).on);
			return send(res, 200, { ok: true });
		}
		if (route === 'POST /__fake/respond-next') {
			const c = JSON.parse(raw || '{}') as Canned & { times?: number };
			state.respondNext({ status: c.status, body: c.body, headers: c.headers }, c.times ?? 1);
			return send(res, 200, { ok: true });
		}

		const m = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([^/]+)$/.exec(url.pathname);
		if (req.method !== 'POST' || !m) return send(res, 404, { message: '404: Not Found', code: 0 });
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return send(res, 400, { message: 'Cannot send an empty message', code: 50006 });
		}
		const next = canned.shift();
		if (next) return send(res, next.status, next.body ?? {}, next.headers);
		const flags = typeof body.flags === 'number' ? body.flags : 0;
		const v2 = (flags & COMPONENTS_V2) !== 0;
		if (v2 && (state.refuseComponents || url.searchParams.get('with_components') !== 'true')) {
			return send(res, 400, { message: 'Invalid Form Body', code: 50035, errors: { components: {} } });
		}
		if (v2 && ('content' in body || 'embeds' in body)) {
			return send(res, 400, { message: 'Invalid Form Body', code: 50035 });
		}
		state.messages.push({
			at: Date.now(),
			webhookId: m[1] as string,
			token: m[2] as string,
			query: Object.fromEntries(url.searchParams),
			body
		});
		const headers = {
			'x-ratelimit-limit': '5',
			'x-ratelimit-remaining': '4',
			'x-ratelimit-reset-after': '1'
		};
		if (url.searchParams.get('wait') === 'true') {
			return send(res, 200, { id: String(state.messages.length), channel_id: '1', ...body }, headers);
		}
		res.writeHead(204, headers);
		res.end();
	});

	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			const addr = server.address();
			state.port = typeof addr === 'object' && addr ? addr.port : port;
			state.url = `http://127.0.0.1:${state.port}/api/v10`;
			resolve(state);
		});
	});
}
