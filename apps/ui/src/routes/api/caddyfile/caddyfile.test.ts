import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Timing } from '$lib/server/timing';
import { setConfigServiceForTests } from '$lib/server/config';
import { FakeAdmin } from '$lib/server/config/fake-admin';
import { ConfigService } from '$lib/server/config/service';
import { openDb } from '$lib/server/db';
import { GET, PUT } from './+server';
import { POST as VALIDATE } from './validate/+server';
import { POST as FORMAT } from './format/+server';
import { GET as REVISIONS } from './revisions/+server';
import { GET as REVISION } from './revisions/[id]/+server';
import { POST as RESTORE } from './revisions/[id]/restore/+server';
import { GET as STATUS } from '../caddy/status/+server';
import { GET as UPSTREAMS } from '../caddy/upstreams/+server';

const TEXT = 'a.example.com {\n\treverse_proxy 10.0.0.20:80\n}\n';
let dir: string;
let file: string;
let admin: FakeAdmin;

// The handlers only read these fields of the event.
type Ev = { request: Request; locals: App.Locals; params: Record<string, string> };
const locals: App.Locals = {
	identity: { user: 'david', via: 'session' },
	theme: 'system',
	timing: new Timing()
};
const ev = (init?: { method?: string; body?: unknown; params?: Record<string, string> }) =>
	({
		request: new Request('http://ui/api/caddyfile', {
			method: init?.method ?? 'GET',
			body:
				init?.body === undefined
					? undefined
					: typeof init.body === 'string'
						? init.body
						: JSON.stringify(init.body)
		}),
		locals,
		params: init?.params ?? {}
	}) as Ev as never;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'caddy-ui-api-'));
	file = join(dir, 'Caddyfile');
	await writeFile(file, TEXT);
	admin = new FakeAdmin();
	admin.running = (FakeAdmin.adaptText(TEXT) as { config: unknown }).config;
	const svc = new ConfigService({
		admin,
		db: openDb(':memory:'),
		caddyfilePath: file,
		backupDir: join(dir, 'b')
	});
	await svc.init();
	setConfigServiceForTests(svc);
});

afterEach(async () => {
	setConfigServiceForTests(undefined);
	await rm(dir, { recursive: true, force: true });
});

describe('/api/caddyfile', () => {
	it('GET returns the document, uncached', async () => {
		const res = await GET(ev());
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toMatchObject({
			text: TEXT,
			drift: { state: 'in_sync' },
			parser: 'unavailable'
		});
	});

	it('PUT applies, records the signed-in user and returns the revision', async () => {
		const next = TEXT.replace(':80', ':81');
		const res = await PUT(ev({ method: 'PUT', body: { text: next, note: 'port' } }));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ changed: true, revision: { author: 'david', note: 'port' } });
		expect(await readFile(file, 'utf8')).toBe(next);
	});

	it('PUT answers 400, 409 and 422 with JSON bodies', async () => {
		expect((await PUT(ev({ method: 'PUT', body: 'nope' }))).status).toBe(400);
		expect((await PUT(ev({ method: 'PUT', body: { text: 1 } }))).status).toBe(400);
		const conflict = await PUT(ev({ method: 'PUT', body: { text: TEXT, baseHash: 'stale' } }));
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ code: 'conflict' });
		const invalid = await PUT(ev({ method: 'PUT', body: { text: TEXT + 'bogus\n' } }));
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toMatchObject({ code: 'invalid', diagnostics: [{ line: 4 }] });
	});

	it('answers 503 when Caddy is unreachable', async () => {
		admin.reachable = false;
		expect((await PUT(ev({ method: 'PUT', body: { text: TEXT + '#\n' } }))).status).toBe(503);
		expect((await VALIDATE(ev({ method: 'POST', body: { text: TEXT } }))).status).toBe(503);
		expect((await UPSTREAMS(ev())).status).toBe(503);
		const status = await STATUS(ev());
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ reachable: false });
	});

	it('validate and format', async () => {
		const ok = await VALIDATE(ev({ method: 'POST', body: { text: TEXT } }));
		expect(await ok.json()).toEqual({ ok: true, diagnostics: [] });
		const bad = await VALIDATE(ev({ method: 'POST', body: { text: 'bogus' } }));
		expect(await bad.json()).toMatchObject({ ok: false, diagnostics: [{ line: 1 }] });
		expect((await FORMAT(ev({ method: 'POST', body: { text: TEXT } }))).status).toBe(501);
	});

	it('lists, reads and restores revisions', async () => {
		await PUT(ev({ method: 'PUT', body: { text: TEXT.replace(':80', ':82') } }));
		const { revisions } = await (await REVISIONS(ev())).json();
		expect(revisions).toHaveLength(2);
		const first = revisions[1].id as number;
		const one = await (await REVISION(ev({ params: { id: String(first) } }))).json();
		expect(one.text).toBe(TEXT);
		expect((await REVISION(ev({ params: { id: 'x' } }))).status).toBe(404);
		const restored = await RESTORE(ev({ method: 'POST', params: { id: String(first) } }));
		expect(await restored.json()).toMatchObject({ changed: true, loaded: true });
		expect(await readFile(file, 'utf8')).toBe(TEXT);
		expect((await RESTORE(ev({ method: 'POST', params: { id: '999' } }))).status).toBe(404);
	});
});
