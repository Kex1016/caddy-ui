import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPorkbunForTests, useFakePorkbun } from '$lib/server/porkbun/testing';
import { inspectBundle } from '$lib/server/porkbun-ssl';

// The switch lives in the environment; the tests flip it here.
const switches = { sslKeyDownload: false };
vi.mock('$lib/server/env', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/env')>();
	return {
		...real,
		config: () => {
			const c = real.config();
			return { ...c, porkbun: { ...c.porkbun, ...switches } };
		}
	};
});

import { DELETE as deleteForward } from './[domain]/forwards/[id]/+server';
import { GET as listForwards, POST as addForward } from './[domain]/forwards/+server';
import { GET as sslInfo } from './[domain]/ssl/+server';
import { GET as sslDownload } from './[domain]/ssl/download/+server';

// A self-signed test certificate (no key) for example.com and *.example.com, made for these tests.
const CERT = `-----BEGIN CERTIFICATE-----
MIIB1jCCAXygAwIBAgIUK2ng5x7xenApWPA5dHSs+ARm1wowCgYIKoZIzj0EAwIw
LTEUMBIGA1UEAwwLZXhhbXBsZS5jb20xFTATBgNVBAoMDEV4YW1wbGUgVGVzdDAe
Fw0yNjExMTgyMjEyMjlaFw0zNjExMTUyMjEyMjlaMC0xFDASBgNVBAMMC2V4YW1w
bGUuY29tMRUwEwYDVQQKDAxFeGFtcGxlIFRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQdAL8Jmk9YIBy5hq/yNH2MN0xKupyks/fVgYZ4z2DQA5UpynqQBQ67
MC1L5qOuL9HXLdeMXQ+ydSBFaxrNsICNo3oweDAdBgNVHQ4EFgQUsJgKKhi7J+9l
l//TVji/C2JlOngwHwYDVR0jBBgwFoAUsJgKKhi7J+9ll//TVji/C2JlOngwDwYD
VR0TAQH/BAUwAwEB/zAlBgNVHREEHjAcggtleGFtcGxlLmNvbYINKi5leGFtcGxl
LmNvbTAKBggqhkjOPQQDAgNIADBFAiEAz5bd9Xfj0YsMBougBOLc/ztu0UshaJ87
i6EhX6+DXEUCIAyELZFwe6LnI331l2oiDfBv75Qkoe7sHN3sNt3gIo1r
-----END CERTIFICATE-----
`;

let ctx: ReturnType<typeof useFakePorkbun>;
beforeEach(() => {
	switches.sslKeyDownload = false;
	ctx = useFakePorkbun();
});
afterEach(() => resetPorkbunForTests());

const locals = { identity: { user: 'david', via: 'open' } };
const event = (
	domain: string,
	init: { path?: string; method?: string; body?: unknown; headers?: Record<string, string>; id?: string } = {}
) => {
	const url = new URL(`http://localhost/api/porkbun/domains/${domain}${init.path ?? ''}`);
	return {
		url,
		params: { domain, ...(init.id ? { id: init.id } : {}) },
		locals,
		request: new Request(url, {
			method: init.method ?? 'GET',
			headers: init.headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body)
		})
	} as never;
};

const forward = {
	subdomain: 'www',
	location: 'https://example.org/',
	redirectType: '302',
	includePath: false,
	wildcard: true
};

async function thrown(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	throw new Error('expected a throw');
}

describe('URL forwards', () => {
	it('lists the forwards of the account', async () => {
		const res = await listForwards(event('example.com'));
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = await res.json();
		expect(body.stale).toBe(false);
		expect(body.data).toMatchObject([
			{ subdomain: 'old', redirectType: '301', includePath: true, wildcard: false }
		]);
	});

	it('round-trips: add, list, delete, list', async () => {
		const added = await addForward(event('example.com', { method: 'POST', body: forward }));
		expect(added.status).toBe(200);
		expect(await added.json()).toMatchObject({ ok: true });

		const after = (await (await listForwards(event('example.com'))).json()).data;
		const created = after.find((f: { subdomain: string }) => f.subdomain === 'www');
		expect(created).toMatchObject({
			location: 'https://example.org/',
			redirectType: '302',
			includePath: false,
			wildcard: true
		});
		expect(ctx.fake.writes.map((w) => w.path)).toEqual(['domain/addUrlForward/example.com']);

		const gone = await deleteForward(event('example.com', { method: 'DELETE', id: created.id }));
		expect(gone.status).toBe(200);
		const rest = (await (await listForwards(event('example.com'))).json()).data;
		expect(rest.map((f: { subdomain: string }) => f.subdomain)).toEqual(['old']);
	});

	it('logs both writes, with what a delete replaced', async () => {
		await addForward(event('example.com', { method: 'POST', body: forward }));
		const [row] = ctx.db
			.prepare('SELECT action, before_json, ok FROM porkbun_audit ORDER BY id DESC')
			.all() as { action: string; before_json: string; ok: number }[];
		expect(row).toMatchObject({ action: 'forward.add', ok: 1 });
		const id = (await (await listForwards(event('example.com'))).json()).data.find(
			(f: { subdomain: string }) => f.subdomain === 'old'
		).id;
		await deleteForward(event('example.com', { method: 'DELETE', id }));
		const last = ctx.db
			.prepare('SELECT action, before_json FROM porkbun_audit ORDER BY id DESC LIMIT 1')
			.get() as { action: string; before_json: string };
		expect(last.action).toBe('forward.delete');
		expect(JSON.parse(last.before_json)).toMatchObject({
			subdomain: 'old',
			location: 'https://www.example.com'
		});
	});

	it('refuses invalid input before calling Porkbun', async () => {
		const before = ctx.fake.requests.length;
		const res = await addForward(
			event('example.com', { method: 'POST', body: { ...forward, location: 'ftp://x' } })
		);
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe('BAD_REQUEST');
		const bad = await addForward(event('example.com', { method: 'POST', body: undefined }));
		expect(bad.status).toBe(400);
		expect(ctx.fake.writes).toHaveLength(0);
		// only the domain list was read
		expect(ctx.fake.requests.length - before).toBeLessThanOrEqual(2);
	});

	it('refuses a second forward for the same name', async () => {
		const res = await addForward(
			event('example.com', { method: 'POST', body: { ...forward, subdomain: 'old' } })
		);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe('DUPLICATE_FORWARD');
		expect(ctx.fake.writes).toHaveLength(0);
	});

	it('404s a forward that is not on the domain and a domain that is not in the account', async () => {
		expect((await deleteForward(event('example.com', { method: 'DELETE', id: '9999' }))).status).toBe(404);
		expect((await deleteForward(event('example.com', { method: 'DELETE', id: '../x' }))).status).toBe(400);
		const err = await thrown(() => listForwards(event('nope.example')));
		expect(isHttpError(err) && err.status).toBe(404);
	});

	it('is refused in read-only mode', async () => {
		useFakePorkbun({ settings: { readonly: true } });
		const err = await thrown(() => addForward(event('example.com', { method: 'POST', body: forward })));
		expect(isHttpError(err) && err.status).toBe(403);
		expect(ctx.fake.writes).toHaveLength(0);
	});

	it('is refused when the key lacks the dns permission', async () => {
		ctx.fake.scopes = ['read'];
		const err = await thrown(() => addForward(event('example.com', { method: 'POST', body: forward })));
		expect(isHttpError(err) && err.status).toBe(403);
		expect(ctx.fake.writes).toHaveLength(0);
	});
});

describe('SSL bundle', () => {
	const PRIVATE = 'fake private key';

	it('describes the certificate and never carries the key', async () => {
		const res = await sslInfo(event('example.com', { path: '/ssl' }));
		expect(res.headers.get('cache-control')).toBe('no-store');
		const text = await res.text();
		expect(text).not.toContain(PRIVATE);
		expect(text).not.toMatch(/PRIVATE KEY/);
		const body = JSON.parse(text);
		expect(body).toMatchObject({ keyAvailable: true, keyDownloadEnabled: false, chainLength: 2 });
	});

	it('reads a real certificate', () => {
		const info = inspectBundle({ certificateChain: CERT, privateKey: 'x', publicKey: '' }, false);
		expect(info.unreadable).toBe(false);
		expect(info.certificates[0]).toMatchObject({
			subject: expect.stringContaining('CN=example.com'),
			issuer: expect.stringContaining('CN=example.com'),
			altNames: ['example.com', '*.example.com'],
			isCa: expect.any(Boolean)
		});
		expect(info.certificates[0]!.validTo > info.certificates[0]!.validFrom).toBe(true);
		expect(JSON.stringify(info)).not.toContain('"x"');
	});

	it('keeps nothing: no cache row, no audit row, and a fresh call each time', async () => {
		await sslInfo(event('example.com', { path: '/ssl' }));
		await sslInfo(event('example.com', { path: '/ssl' }));
		expect(ctx.fake.requests.filter((r) => r.path.startsWith('ssl/'))).toHaveLength(2);
		const cache = ctx.db.prepare('SELECT key, json FROM porkbun_cache').all() as {
			key: string;
			json: string;
		}[];
		expect(cache.some((r) => /ssl|PRIVATE/i.test(r.key + r.json))).toBe(false);
		expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM porkbun_audit').get()).toEqual({ n: 0 });
	});

	it('serves the chain as a download', async () => {
		const res = await sslDownload(event('example.com', { path: '/ssl/download?part=chain' }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toBe('attachment; filename="example.com-fullchain.pem"');
		expect(res.headers.get('cache-control')).toBe('no-store');
		const text = await res.text();
		expect(text).toContain('BEGIN CERTIFICATE');
		expect(text).not.toMatch(/PRIVATE KEY/);
	});

	it('never serves the private key unless the switch is on', async () => {
		const res = await sslDownload(event('example.com', { path: '/ssl/download?part=key' }));
		expect(res.status).toBe(403);
		const text = await res.text();
		expect(JSON.parse(text).code).toBe('KEY_DOWNLOAD_DISABLED');
		expect(text).not.toMatch(/PRIVATE KEY/);
		// Porkbun was not even asked for the bundle.
		expect(ctx.fake.requests.some((r) => r.path.startsWith('ssl/'))).toBe(false);
	});

	it('serves the key with the switch on, logs the download and keeps the key out of the log', async () => {
		switches.sslKeyDownload = true;
		const res = await sslDownload(event('example.com', { path: '/ssl/download?part=key' }));
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.text()).toMatch(/PRIVATE KEY/);
		const rows = ctx.db.prepare('SELECT * FROM porkbun_audit').all() as Record<string, string>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ action: 'ssl.key-download', domain: 'example.com', author: 'david' });
		expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|fake private key/);
		const cache = ctx.db.prepare('SELECT json FROM porkbun_cache').all();
		expect(JSON.stringify(cache)).not.toMatch(/PRIVATE|fake private key/);
	});

	it('refuses a key download started from another site, and an unknown part', async () => {
		switches.sslKeyDownload = true;
		const cross = await sslDownload(
			event('example.com', { path: '/ssl/download?part=key', headers: { 'sec-fetch-site': 'cross-site' } })
		);
		expect(cross.status).toBe(403);
		const bad = await sslDownload(event('example.com', { path: '/ssl/download?part=public' }));
		expect(bad.status).toBe(400);
	});

	it('passes on Porkbun having no certificate yet', async () => {
		const res = await sslInfo(event('example.net', { path: '/ssl' }));
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(await res.json()).toMatchObject({ error: { retryable: false } });
	});
});
