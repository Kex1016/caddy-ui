import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Timing } from '$lib/server/timing';
import { setConfigServiceForTests } from '$lib/server/config';
import { FakeAdmin } from '$lib/server/config/fake-admin';
import { ConfigService } from '$lib/server/config/service';
import { openDb } from '$lib/server/db';
import { siteId } from '$lib/server/collector/sites';
import { NOT_REGISTERED } from '$lib/server/caddy/porkbun/testing';
import { actions as siteActions } from './[id]/+page.server';
import { actions } from './+page.server';

const TEXT = 'a.example.com {\n\treverse_proxy 10.0.0.20:80\n}\n\nb.example.com {\n\trespond hi\n}\n';
let dir: string;
let file: string;
let admin: FakeAdmin;
let svc: ConfigService;

const locals: App.Locals = {
	identity: { user: 'david', via: 'session' },
	theme: 'system',
	timing: new Timing()
};

type Action = (e: never) => Promise<unknown>;
async function run(name: keyof typeof actions, fields: Record<string, string>, baseHash?: string) {
	const body = new URLSearchParams({ baseHash: baseHash ?? (await svc.readFile()).hash, ...fields });
	const request = new Request('http://ui/sites', { method: 'POST', body });
	return (await (actions[name] as unknown as Action)({ request, locals } as never)) as {
		status?: number;
		ok?: boolean;
		data?: { message: string };
		message?: string;
		added?: string[];
		dns01?: string;
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
			recipe: 'reverse_proxy',
			f_upstream: '10.0.0.9:80'
		});
		expect(r.ok).toBe(true);
		expect(await disk()).toBe(TEXT + '\nc.example.com {\n\treverse_proxy 10.0.0.9:80\n}\n');
		expect(admin.loads).toHaveLength(1);
		expect(svc.listRevisions()[0]?.note).toBe('Added site c.example.com');
	});

	it('add renders recipe fields, including toggles and selects', async () => {
		const r = await run('add', {
			addresses: 'files.example.com',
			recipe: 'static',
			f_root: '/srv/www',
			f_browse: 'on',
			f_encode: 'on'
		});
		expect(r.ok).toBe(true);
		expect(await disk()).toContain(
			'files.example.com {\n\troot * /srv/www\n\tencode zstd gzip\n\tfile_server browse\n}\n'
		);
		const redirect = await run('add', {
			addresses: 'old.example.com',
			recipe: 'redirect',
			f_target: 'https://new.example.com',
			f_keepPath: 'on',
			f_code: 'temporary'
		});
		expect(redirect.ok).toBe(true);
		expect(await disk()).toContain('old.example.com {\n\tredir https://new.example.com{uri}\n}\n');
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
		expect((await run('add', { addresses: '', recipe: 'blank' })).status).toBe(400);
		expect((await run('add', { addresses: 'a.example.com', recipe: 'blank' })).status).toBe(409);
		expect((await run('add', { addresses: 'z.com', recipe: 'nope' })).status).toBe(400);
		const missing = await run('add', { addresses: 'z.com', recipe: 'reverse_proxy', f_upstream: '' });
		expect(missing.status).toBe(400);
		expect((missing.data as { field?: string } | undefined)?.field).toBe('upstream');
		expect((await run('delete', { id: 'unknown' })).status).toBe(404);
		expect(await disk()).toBe(TEXT);
	});
});

/** docs/porkbun-plan.md §4: the wildcard hint's action and the DNS record step after adding a site. */
describe('the Porkbun tie-in on the Sites pages', () => {
	const BLOCK =
		'\ttls {\n\t\tdns porkbun {\n\t\t\tapi_key {env.PORKBUN_API_KEY}\n\t\t\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}\n\t\t}\n\t}\n';
	const wildcard = siteId(['*.example.com']);
	const addWildcard = () =>
		run('add', { addresses: '*.example.com', recipe: 'reverse_proxy', f_upstream: '10.0.0.9:80' });

	it('add answers the host names of the new site, so the page can offer their DNS records', async () => {
		const r = await run('add', {
			addresses: 'https://c.example.com:8443, :9000, *.example.com, 10.0.0.7',
			recipe: 'reverse_proxy',
			f_upstream: '10.0.0.9:80'
		});
		expect(r.ok).toBe(true);
		expect(r.added).toEqual(['c.example.com', '*.example.com']);
	});

	it('dns01 gives a wildcard site the Porkbun DNS challenge, with placeholders for the keys', async () => {
		await addWildcard();
		const r = await run('dns01', { id: wildcard });
		expect(r.ok).toBe(true);
		expect(r.dns01).toBe(wildcard);
		expect(r.message).toContain('*.example.com');
		expect(await disk()).toContain(`*.example.com {\n${BLOCK}\treverse_proxy 10.0.0.9:80\n}\n`);
		expect(svc.listRevisions()[0]?.note).toBe('Added the Porkbun DNS challenge to *.example.com');
		expect(admin.loads).toHaveLength(2);

		// Asking twice changes nothing; an unknown site is a 404.
		const before = await disk();
		expect((await run('dns01', { id: wildcard })).status).toBe(409);
		expect((await run('dns01', { id: 'unknown' })).status).toBe(404);
		expect(await disk()).toBe(before);
	});

	it('dns01 keeps a tls block the site already has', async () => {
		await writeFile(file, '*.example.com {\n\ttls {\n\t\tprotocols tls1.3\n\t}\n\trespond hi\n}\n');
		const r = await run('dns01', { id: wildcard });
		expect(r.ok).toBe(true);
		const text = await disk();
		expect(text).toContain('protocols tls1.3');
		expect(text).toContain('dns porkbun {\n\t\t\tapi_key {env.PORKBUN_API_KEY}');
		expect(text.match(/\btls \{/g)).toHaveLength(1);
	});

	it('the site page has the same action', async () => {
		await addWildcard();
		type SiteAction = (e: never) => Promise<{ ok?: boolean; status?: number; message?: string }>;
		const dns01 = siteActions.dns01 as unknown as SiteAction;
		const r = await dns01({ params: { id: wildcard }, locals } as never);
		expect(r.ok).toBe(true);
		expect(await disk()).toContain(BLOCK);
		expect((await dns01({ params: { id: wildcard }, locals } as never)).status).toBe(409);
		expect((await dns01({ params: { id: 'unknown' }, locals } as never)).status).toBe(404);
	});

	it('writes nothing when the running Caddy has no Porkbun plugin and refuses the file', async () => {
		await addWildcard();
		const before = await disk();
		const adapt = admin.adapt.bind(admin);
		admin.adapt = async (text) =>
			text.includes('dns porkbun')
				? { ok: false, diagnostics: [{ severity: 'error', source: 'adapt', message: NOT_REGISTERED }] }
				: adapt(text);
		const r = await run('dns01', { id: wildcard });
		expect(r.status).toBe(422);
		expect(r.data?.message).toBeDefined();
		expect(await disk()).toBe(before);
	});
});
