import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigServiceForTests } from '$lib/server/config';
import { FakeAdmin } from '$lib/server/config/fake-admin';
import { ConfigService } from '$lib/server/config/service';
import { openDb } from '$lib/server/db';
import { siteId } from '$lib/server/collector/sites';
import { actions } from './+page.server';

const TEXT = 'a.example.com {\n\treverse_proxy 10.0.0.20:80\n}\n\nb.example.com {\n\trespond hi\n}\n';
let dir: string;
let file: string;
let admin: FakeAdmin;
let svc: ConfigService;

const locals: App.Locals = { identity: { user: 'david', via: 'session' }, theme: 'system' };

type Action = (e: never) => Promise<unknown>;
async function run(name: keyof typeof actions, fields: Record<string, string>, baseHash?: string) {
	const body = new URLSearchParams({ baseHash: baseHash ?? (await svc.readFile()).hash, ...fields });
	const request = new Request('http://ui/sites', { method: 'POST', body });
	return (await (actions[name] as unknown as Action)({ request, locals } as never)) as {
		status?: number;
		ok?: boolean;
		data?: { message: string };
		message?: string;
	};
}
const disk = () => readFile(file, 'utf8');

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'caddy-ui-w8-'));
	file = join(dir, 'Caddyfile');
	await writeFile(file, TEXT);
	admin = new FakeAdmin();
	admin.running = (FakeAdmin.adaptText(TEXT) as { config: unknown }).config;
	svc = new ConfigService({
		admin,
		db: openDb(':memory:'),
		caddyfilePath: file,
		backupDir: join(dir, 'backups')
	});
	await svc.init();
	setConfigServiceForTests(svc);
});

afterEach(async () => {
	svc.unwatch();
	setConfigServiceForTests(undefined);
	await rm(dir, { recursive: true, force: true });
});

describe('sites actions', () => {
	it('add writes the block, loads it into Caddy and records a revision', async () => {
		const r = await run('add', {
			addresses: 'c.example.com',
			starter: 'reverse_proxy',
			value: '10.0.0.9:80'
		});
		expect(r.ok).toBe(true);
		expect(await disk()).toBe(TEXT + '\nc.example.com {\n\treverse_proxy 10.0.0.9:80\n}\n');
		expect(admin.loads).toHaveLength(1);
		expect(svc.listRevisions()[0]?.note).toBe('Added site c.example.com');
	});

	it('duplicate, disable, enable, move and delete each round-trip through the service', async () => {
		const a = siteId(['a.example.com']);
		await run('duplicate', { id: a, addresses: 'a2.example.com' });
		expect(await disk()).toContain('a2.example.com {\n\treverse_proxy 10.0.0.20:80\n}');

		await run('toggle', { id: a, disable: '1' });
		expect(await disk()).toContain('# caddy-ui:disabled lines=3');
		await run('toggle', { id: a, disable: '0' });
		expect(await disk()).not.toContain('caddy-ui:disabled');

		await run('move', { id: siteId(['b.example.com']), direction: 'up' });
		expect((await disk()).indexOf('b.example.com')).toBeLessThan((await disk()).indexOf('a2.example.com'));

		await run('delete', { id: siteId(['a2.example.com']) });
		expect(await disk()).not.toContain('a2.example.com');
		expect(await disk()).toContain('a.example.com');
	});

	it('disabling a site removes it from what Caddy runs', async () => {
		await run('toggle', { id: siteId(['b.example.com']), disable: '1' });
		expect(JSON.stringify(admin.running)).not.toContain('respond hi');
	});

	it('answers 409 when the file changed since the page was loaded, and writes nothing', async () => {
		const stale = (await svc.readFile()).hash;
		await writeFile(file, TEXT + '\n# edited elsewhere\n');
		const before = await disk();
		const r = await run('delete', { id: siteId(['a.example.com']) }, stale);
		expect(r.status).toBe(409);
		expect(await disk()).toBe(before);
	});

	it('rejects bad input with 400 and a duplicate with 409', async () => {
		expect((await run('add', { addresses: '', starter: 'blank' })).status).toBe(400);
		expect((await run('add', { addresses: 'a.example.com', starter: 'blank' })).status).toBe(409);
		expect((await run('add', { addresses: 'z.com', starter: 'nope' })).status).toBe(400);
		expect((await run('delete', { id: 'unknown' })).status).toBe(404);
		expect(await disk()).toBe(TEXT);
	});
});
