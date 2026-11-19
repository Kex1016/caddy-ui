// A fake Porkbun API v3 over HTTP for the e2e suite (docs/porkbun-plan.md §5, P7). It is the same in-memory
// fake the unit tests use (apps/ui/src/lib/server/porkbun/fake.ts, seeded from fixtures/seed.json), served
// with node:http so the built UI can reach it through PORKBUN_API_URL. Nothing here talks to the real API.
//
// Porkbun's own paths live under /api/json/v3/. Specs arrange state through /__fake/*:
//   POST /__fake/reset                      a fresh fake from the seed
//   POST /__fake/scopes      {scopes}       narrow the key, as /ping would report it
//   POST /__fake/respond-next {canned,times} answer the next requests with a canned response
//   POST /__fake/record-limit {limit}       zone size ceiling (the real one is 2,500)
//   POST /__fake/ssl         {domain,certificatechain} serve a real chain (the fake's own is placeholder text)
//   POST /__fake/many-domains {count}       add count domains named e2e-0001.example and up
//   POST /__fake/domain      {domain,patch} change a domain's flags
//   POST /__fake/records     {domain,records} replace a zone's records (no restore point)
//   GET  /__fake/records?domain=            the zone as the fake stores it
//   GET  /__fake/requests                   every request received since the last reset
//
// Run alone with `node support/porkbun-fake.mjs` (port E2E_PORKBUN_PORT, default 3102); stack.mjs starts it.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths, PORKBUN_PORT } from './paths.mjs';

const porkbunDir = join(paths.uiDir, 'src', 'lib', 'server', 'porkbun');
// Node 22.18+ loads fake.ts as it is: it has no runtime imports and only erasable TypeScript.
const { FakePorkbun } = await import(pathToFileURL(join(porkbunDir, 'fake.ts')).href);
const seed = JSON.parse(readFileSync(join(porkbunDir, 'fixtures', 'seed.json'), 'utf8'));

/** The fake key pair from the seed. Not a real key: Porkbun keys look like `pk1_<64 hex>`. */
export const fakeCredentials = { apiKey: seed.apiKey, apiSecret: seed.apiSecret };

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function send(res, status, body) {
	const text = JSON.stringify(body ?? {});
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
	res.end(text);
}

export function startPorkbunFake(port = PORKBUN_PORT) {
	let fake = new FakePorkbun(seed);
	/** Certificate chains to serve from /ssl/retrieve instead of the fake's placeholder text, by domain. */
	let sslChains = new Map();

	async function control(req, res, url, raw) {
		const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
		const route = `${req.method} ${url.pathname}`;
		switch (route) {
			case 'POST /__fake/reset':
				fake = new FakePorkbun(seed);
				sslChains = new Map();
				return send(res, 200, { ok: true });
			case 'POST /__fake/scopes':
				fake.scopes = body.scopes;
				return send(res, 200, { ok: true });
			case 'POST /__fake/respond-next':
				fake.respondNext(body.canned, body.times ?? 1);
				return send(res, 200, { ok: true });
			case 'POST /__fake/record-limit':
				fake.recordLimit = body.limit;
				return send(res, 200, { ok: true });
			case 'POST /__fake/ssl':
				sslChains.set(body.domain, body.certificatechain);
				return send(res, 200, { ok: true });
			case 'POST /__fake/many-domains': {
				// `count` extra domains under the reserved .example TLD, for the 1,000-domain budget.
				const template = seed.domains[0];
				for (let i = 1; i <= body.count; i++) {
					const name = `e2e-${String(i).padStart(4, '0')}.example`;
					fake.addDomain({ ...template, domain: name, labels: [], records: [], forwards: [], glue: [] });
				}
				return send(res, 200, { ok: true });
			}
			case 'POST /__fake/domain':
				fake.setDomain(body.domain, body.patch);
				return send(res, 200, { ok: true });
			case 'POST /__fake/records':
				fake.setRecords(body.domain, body.records);
				return send(res, 200, { ok: true });
			case 'GET /__fake/records':
				return send(res, 200, fake.records(url.searchParams.get('domain') ?? ''));
			case 'GET /__fake/requests':
				return send(res, 200, fake.requests);
			default:
				return send(res, 404, { error: `no fake control ${route}` });
		}
	}

	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
			const raw = await readBody(req);
			if (url.pathname.startsWith('/__fake/')) return await control(req, res, url, raw);
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === 'string') headers.set(k, v);
				else if (Array.isArray(v)) headers.set(k, v.join(', '));
			}
			const request = new Request(url, {
				method: req.method,
				headers,
				body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw
			});
			let response;
			try {
				response = await fake.handle(request);
			} catch {
				// throwNext(): behave like a dropped connection.
				req.socket.destroy();
				return;
			}
			let out = Buffer.from(await response.arrayBuffer());
			const ssl = /\/ssl\/retrieve\/([^/]+)$/.exec(url.pathname);
			if (ssl && response.status === 200 && sslChains.has(decodeURIComponent(ssl[1]))) {
				const answer = JSON.parse(out.toString('utf8'));
				answer.certificatechain = sslChains.get(decodeURIComponent(ssl[1]));
				out = Buffer.from(JSON.stringify(answer));
			}
			const head = {};
			response.headers.forEach((v, k) => (head[k] = v));
			head['content-length'] = String(out.length);
			res.writeHead(response.status, head);
			res.end(out);
		} catch (err) {
			send(res, 500, { status: 'ERROR', code: 'FAKE_SERVER', message: String(err) });
		}
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => resolve(server));
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await startPorkbunFake();
	console.log(`fake Porkbun on http://127.0.0.1:${PORKBUN_PORT}/api/json/v3`);
}
