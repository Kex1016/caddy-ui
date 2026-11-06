import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaddyAdmin } from '../caddy/admin';
import { configHash, processFacts } from '../caddy/inspect';
import { openDb } from '../db';
import { installCaddyfileParser } from './caddyfile-parser';
import { getParser } from './parser';
import { ApplyError, ConfigService } from './service';

/**
 * PLAN.md §5.1 W3 against a real Caddy. Run with `pnpm --filter @caddy-ui/ui test:caddy` and
 * CADDY_TEST_ADMIN_URL pointing at a Caddy whose admin API listens on a reachable address.
 */
const adminUrl = process.env.CADDY_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('Set CADDY_TEST_ADMIN_URL to a Caddy admin API, e.g. http://127.0.0.1:2019');

const SAMPLE = await readFile(new URL('./fixtures/sample.Caddyfile', import.meta.url), 'utf8');
const admin = new CaddyAdmin(adminUrl);
let dir: string;
let file: string;
let svc: ConfigService;

async function lastReloadAt(): Promise<number | null> {
	return processFacts(await admin.metrics()).lastReload?.at ?? null;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'caddy-ui-real-'));
	file = join(dir, 'Caddyfile');
	await writeFile(file, SAMPLE);
	svc = new ConfigService({
		admin,
		db: openDb(':memory:'),
		caddyfilePath: file,
		backupDir: join(dir, 'backups')
	});
	await svc.init();
	// Bring Caddy to the fixture, as if it had been started with this Caddyfile.
	await svc.apply(SAMPLE, { author: 'ci' });
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('W3 definition of done, against real Caddy', () => {
	it('applying the Caddyfile unchanged changes nothing on disk and nothing in Caddy', async () => {
		const bytes = await readFile(file);
		const configBefore = configHash(await admin.getConfig());
		const reloadBefore = await lastReloadAt();
		expect((await svc.drift()).state).toBe('in_sync');

		const res = await svc.apply(SAMPLE, { author: 'ci' });

		expect(res).toMatchObject({ changed: false, written: false, loaded: false });
		expect(await readFile(file)).toEqual(bytes);
		expect(configHash(await admin.getConfig())).toBe(configBefore);
		expect(await lastReloadAt()).toBe(reloadBefore);
	});

	it('a bad edit returns the /adapt error with the right line and leaves file and Caddy alone', async () => {
		const configBefore = configHash(await admin.getConfig());
		const lines = SAMPLE.split('\n');
		const at = lines.indexOf('media.home.localhost {') + 2; // 1-based line of the new directive
		lines.splice(at - 1, 0, '\tbogus_directive foo');
		const err = await svc.apply(lines.join('\n'), { author: 'ci' }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApplyError);
		const body = (err as ApplyError).body;
		expect((err as ApplyError).status).toBe(422);
		expect(body.diagnostics[0]).toMatchObject({ severity: 'error', source: 'adapt', line: at });
		expect(body.diagnostics[0]?.message).toMatch(/bogus_directive/);
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
		expect(configHash(await admin.getConfig())).toBe(configBefore);
	});

	it('rollback restores the previous revision and reloads Caddy', async () => {
		const original = configHash(await admin.getConfig());
		const first = svc.listRevisions()[0]!;
		const edited = SAMPLE.replace('reverse_proxy 10.0.0.20:8096', 'reverse_proxy 10.0.0.20:8097');
		const applied = await svc.apply(edited, { author: 'ci' });
		expect(applied).toMatchObject({ changed: true, written: true, loaded: true });
		expect(configHash(await admin.getConfig())).not.toBe(original);

		const restored = await svc.restore(first.id, 'ci');
		expect(restored).toMatchObject({ changed: true, written: true, loaded: true });
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
		expect(configHash(await admin.getConfig())).toBe(original);
		expect((await svc.drift()).state).toBe('in_sync');
	});

	it('reports status and owners of upstreams', async () => {
		const status = await svc.status();
		expect(status).toMatchObject({ reachable: true, drift: { state: 'in_sync' } });
		expect(status.startedAt).toBeGreaterThan(0);
		const ups = await svc.upstreams();
		const media = ups.find((u) => u.address === '10.0.0.20:8096');
		expect(media?.sites).toEqual([{ hosts: ['media.home.localhost'] }]);
		const pooled = ups.find((u) => u.address === '10.0.0.41:80');
		expect(pooled?.sites).toEqual([{ hosts: ['apps.home.localhost'] }]);
	});

	it('notices an outside edit and refuses a stale overwrite', async () => {
		const base = (await svc.document()).hash;
		await writeFile(file, SAMPLE.replace('10.0.0.21:3000', '10.0.0.21:3001'));
		expect(await svc.checkForExternalEdit()).not.toBeNull();
		expect((await svc.drift()).state).toBe('file_differs');
		const err = await svc.apply(SAMPLE, { author: 'ci', baseHash: base }).catch((e: unknown) => e);
		expect((err as ApplyError).status).toBe(409);
		await svc.apply(SAMPLE, { author: 'ci' });
		expect((await svc.drift()).state).toBe('in_sync');
	});

	it('every save is written in caddy fmt style without changing what Caddy runs', async () => {
		installCaddyfileParser();
		const fmt = new ConfigService({
			admin,
			db: openDb(':memory:'),
			caddyfilePath: file,
			backupDir: join(dir, 'backups'),
			parser: getParser
		});
		await fmt.init();
		const configBefore = configHash(await admin.getConfig());
		const reloadBefore = await lastReloadAt();
		// Spaces for tabs, extra blank lines and trailing whitespace, as a hand edit might leave it. (Trailing
		// whitespace after a directive: caddy fmt keeps it inside a comment, so format() does too.)
		const messy = SAMPLE.replace(/\t/g, '    ')
			.replace('# Media\n', '\n\n\n# Media\n')
			.replace('10.0.0.20:8096\n', '10.0.0.20:8096   \n');
		await writeFile(file, messy);
		await fmt.checkForExternalEdit();

		const res = await fmt.apply(messy, { author: 'ci' });
		expect(res).toMatchObject({ changed: true, written: true, loaded: false, formatted: true, text: SAMPLE });
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
		expect(configHash(await admin.getConfig())).toBe(configBefore);
		expect(await lastReloadAt()).toBe(reloadBefore);

		const again = await fmt.apply(SAMPLE, { author: 'ci' });
		expect(again).toMatchObject({ changed: false, written: false, loaded: false });

		const edited = messy.replace('reverse_proxy 10.0.0.20:8096', 'reverse_proxy 10.0.0.20:8097');
		const res2 = await fmt.apply(edited, { author: 'ci' });
		expect(res2).toMatchObject({ written: true, loaded: true, formatted: true });
		expect(await readFile(file, 'utf8')).toBe(SAMPLE.replace('10.0.0.20:8096', '10.0.0.20:8097'));
		await fmt.apply(SAMPLE, { author: 'ci' });
		expect(configHash(await admin.getConfig())).toBe(configBefore);
	});
});
