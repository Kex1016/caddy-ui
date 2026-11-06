import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { format } from '@caddy-ui/caddyfile';
import { openDb } from '../db';
import { sha256 } from '../caddy/inspect';
import { FakeAdmin } from './fake-admin';
import { ApplyError, ConfigService } from './service';

const SAMPLE = await readFile(new URL('./fixtures/sample.Caddyfile', import.meta.url), 'utf8');

let dir: string;
let file: string;
let admin: FakeAdmin;
let svc: ConfigService;
let clock: number;

function make(extra: Partial<ConstructorParameters<typeof ConfigService>[0]> = {}) {
	return new ConfigService({
		admin,
		db: openDb(':memory:'),
		caddyfilePath: file,
		backupDir: join(dir, 'backups'),
		now: () => ++clock,
		...extra
	});
}

async function applyError(p: Promise<unknown>): Promise<ApplyError> {
	try {
		await p;
	} catch (err) {
		if (err instanceof ApplyError) return err;
		throw err;
	}
	throw new Error('expected the apply to fail');
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'caddy-ui-w3-'));
	file = join(dir, 'Caddyfile');
	await writeFile(file, SAMPLE);
	admin = new FakeAdmin();
	admin.running = (FakeAdmin.adaptText(SAMPLE) as { config: unknown }).config;
	clock = 1_700_000_000_000;
	svc = make();
	await svc.init();
});

afterEach(async () => {
	svc.unwatch();
	await rm(dir, { recursive: true, force: true });
});

describe('ConfigService.init', () => {
	it('records the file found on disk as the first revision', () => {
		const revs = svc.listRevisions();
		expect(revs).toHaveLength(1);
		expect(revs[0]).toMatchObject({
			author: 'outside the UI',
			note: 'First seen on disk',
			hash: sha256(SAMPLE)
		});
		expect(svc.externalChange).toBeNull();
	});

	it('flags a file that changed while the UI was stopped', async () => {
		const db = openDb(':memory:');
		const first = make({ db });
		await first.init();
		await writeFile(file, SAMPLE + '\n# edited\n');
		const second = make({ db });
		await second.init();
		expect(second.listRevisions()).toHaveLength(2);
		expect(second.externalChange?.hash).toBe(sha256(SAMPLE + '\n# edited\n'));
	});
});

describe('ConfigService.apply', () => {
	it('applying the file unchanged writes nothing and loads nothing', async () => {
		const before = await readFile(file);
		const res = await svc.apply(SAMPLE, { author: 'david' });
		expect(res).toMatchObject({ changed: false, written: false, loaded: false, hash: sha256(SAMPLE) });
		expect(await readFile(file)).toEqual(before);
		expect(admin.loads).toHaveLength(0);
		expect(svc.listRevisions()).toHaveLength(1);
		expect(await readdir(dir)).not.toContain('backups');
	});

	it('loads without writing when Caddy runs something else than the file says', async () => {
		admin.running = { other: true };
		const res = await svc.apply(SAMPLE, { author: 'david' });
		expect(res).toMatchObject({ changed: true, written: false, loaded: true });
		expect((await svc.drift()).state).toBe('in_sync');
	});

	it('writes, backs up, loads and records a valid edit', async () => {
		const next = SAMPLE.replace('10.0.0.20:8096', '10.0.0.20:8097');
		const res = await svc.apply(next, { author: 'david', note: 'move media' });
		expect(res).toMatchObject({ changed: true, written: true, loaded: true, hash: sha256(next) });
		expect(await readFile(file, 'utf8')).toBe(next);
		expect(admin.loads).toEqual([next]);
		const backups = await readdir(join(dir, 'backups'));
		expect(backups).toHaveLength(1);
		expect(await readFile(join(dir, 'backups', backups[0] as string), 'utf8')).toBe(SAMPLE);
		const revs = svc.listRevisions();
		expect(revs[0]).toMatchObject({ author: 'david', note: 'move media', hash: sha256(next) });
	});

	it('a comment-only edit is written but does not reload Caddy', async () => {
		const next = SAMPLE + '# a note\n';
		const res = await svc.apply(next, { author: 'david' });
		expect(res).toMatchObject({ changed: true, written: true, loaded: false });
		expect(admin.loads).toHaveLength(0);
	});

	it('refuses a bad edit with the adapt error on the right line and leaves everything alone', async () => {
		const lines = SAMPLE.split('\n');
		lines.splice(21, 0, '\tbogus_directive foo');
		const bad = lines.join('\n');
		const err = await applyError(svc.apply(bad, { author: 'david' }));
		expect(err.status).toBe(422);
		expect(err.body.code).toBe('invalid');
		expect(err.body.diagnostics[0]).toMatchObject({ severity: 'error', source: 'adapt', line: 22 });
		expect(err.body.message).toMatch(/^Line 22: /);
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
		expect(admin.loads).toHaveLength(0);
	});

	it('puts the old file back when Caddy refuses the load', async () => {
		admin.failNextLoad =
			'loading new config: http app module: start: listening on :443: address already in use';
		const next = SAMPLE.replace('10.0.0.21:3000', '10.0.0.21:3001');
		const err = await applyError(svc.apply(next, { author: 'david' }));
		expect(err.status).toBe(502);
		expect(err.body.code).toBe('load_failed');
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
		expect(svc.listRevisions()).toHaveLength(1);
		// Our own rollback write is not mistaken for an outside edit.
		expect(await svc.checkForExternalEdit()).toBeNull();
	});

	it('refuses to validate or write when Caddy is unreachable', async () => {
		admin.reachable = false;
		const err = await applyError(svc.apply(SAMPLE + '#x\n', { author: 'david' }));
		expect(err.status).toBe(503);
		expect(err.body.code).toBe('unreachable');
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
	});

	it('refuses with 409 when the file changed since the caller read it', async () => {
		const base = sha256(SAMPLE);
		await writeFile(file, SAMPLE + '# someone else\n');
		const err = await applyError(svc.apply(SAMPLE + '# mine\n', { author: 'david', baseHash: base }));
		expect(err.status).toBe(409);
		expect(err.body.currentHash).toBe(sha256(SAMPLE + '# someone else\n'));
	});

	it('creates the file when it does not exist yet', async () => {
		await rm(file);
		const res = await svc.apply(SAMPLE, { author: 'david' });
		expect(res.written).toBe(true);
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
	});

	it('keeps only the newest N revisions and backups', async () => {
		const small = make({ keepRevisions: 3, keepBackups: 2, db: openDb(':memory:') });
		await small.init();
		for (let i = 0; i < 5; i++) await small.apply(`${SAMPLE}# ${i}\n`, { author: 'david' });
		expect(small.listRevisions().map((r) => r.note)).toHaveLength(3);
		expect(await readdir(join(dir, 'backups'))).toHaveLength(2);
	});

	it('runs applies one at a time', async () => {
		const a = svc.apply(SAMPLE.replace('8096', '8001'), { author: 'a' });
		const b = svc.apply(SAMPLE.replace('8096', '8002'), { author: 'b' });
		await Promise.all([a, b]);
		expect(await readFile(file, 'utf8')).toBe(SAMPLE.replace('8096', '8002'));
		expect(svc.listRevisions().map((r) => r.author)).toEqual(['b', 'a', 'outside the UI']);
	});
});

describe('ConfigService.restore', () => {
	it('restores an older revision, reloads Caddy and records the restore', async () => {
		const first = svc.listRevisions()[0]!.id;
		const runningBefore = JSON.stringify(admin.running);
		await svc.apply(SAMPLE.replace('10.0.0.20:8096', '10.0.0.29:1'), { author: 'david' });
		const res = await svc.restore(first, 'david');
		expect(res).toMatchObject({ changed: true, written: true, loaded: true });
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
		expect(JSON.stringify(admin.running)).toBe(runningBefore);
		expect(svc.listRevisions()[0]).toMatchObject({ note: `Restored revision #${first}` });
	});

	it('answers null for an unknown revision', async () => {
		expect(await svc.restore(9999, 'david')).toBeNull();
	});
});

describe('outside edits', () => {
	it('records an outside edit once and clears the flag on the next apply', async () => {
		await writeFile(file, SAMPLE + '# by hand\n');
		const change = await svc.checkForExternalEdit();
		expect(change).toMatchObject({ hash: sha256(SAMPLE + '# by hand\n') });
		expect(await svc.checkForExternalEdit()).toBeNull();
		expect(svc.listRevisions()[0]).toMatchObject({ author: 'outside the UI', note: 'Edited outside the UI' });
		await svc.apply(SAMPLE, { author: 'david' });
		expect(svc.externalChange).toBeNull();
	});

	it('does not report its own writes', async () => {
		await svc.apply(SAMPLE + '# mine\n', { author: 'david' });
		expect(await svc.checkForExternalEdit()).toBeNull();
	});

	it('the watcher notices an edit on disk', async () => {
		svc.watch(20);
		await new Promise((r) => setTimeout(r, 50));
		await writeFile(file, SAMPLE + '# watched\n');
		for (let i = 0; i < 100 && !svc.externalChange; i++) await new Promise((r) => setTimeout(r, 20));
		expect(svc.externalChange?.hash).toBe(sha256(SAMPLE + '# watched\n'));
	});
});

describe('reading', () => {
	it('document() reports text, hash, drift and no parser yet', async () => {
		const doc = await svc.document();
		expect(doc).toMatchObject({
			exists: true,
			text: SAMPLE,
			hash: sha256(SAMPLE),
			cst: null,
			parser: 'unavailable',
			drift: { state: 'in_sync' }
		});
	});

	it('document() uses an installed parser', async () => {
		const withParser = make({
			parser: () => ({
				parse: () => ({
					cst: { blocks: [] },
					diagnostics: [{ severity: 'warning', source: 'parser', message: 'x' }]
				}),
				format: (t) => t
			})
		});
		const doc = await withParser.document();
		expect(doc.parser).toBe('ready');
		expect(doc.cst).toEqual({ blocks: [] });
		expect(doc.diagnostics[0]).toMatchObject({ source: 'parser' });
	});

	it('parser errors block an apply even when Caddy would accept it', async () => {
		const strict = make({
			parser: () => ({
				parse: () => ({
					cst: null,
					diagnostics: [{ severity: 'error', source: 'parser', message: 'unclosed', line: 3 }]
				}),
				format: (t) => t
			})
		});
		const err = await applyError(strict.apply(SAMPLE + '#x\n', { author: 'd' }));
		expect(err.status).toBe(422);
		expect(err.body.message).toBe('Line 3: unclosed');
	});

	it('drift shows a file that differs from the running config, and an unreachable Caddy', async () => {
		await writeFile(file, SAMPLE.replace('8096', '9999'));
		expect((await svc.drift()).state).toBe('file_differs');
		await writeFile(file, SAMPLE + 'bogus\n');
		expect(await svc.drift()).toMatchObject({
			state: 'file_differs',
			message: expect.stringMatching(/line 88/)
		});
		admin.reachable = false;
		expect((await svc.drift()).state).toBe('unknown');
	});

	it('status() reads uptime and last reload from metrics', async () => {
		const st = await svc.status();
		expect(st).toMatchObject({
			reachable: true,
			startedAt: 1_700_000_000_000,
			lastReload: { ok: true, at: 1_700_000_100_000 },
			drift: { state: 'in_sync' },
			configHash: expect.stringMatching(/^[0-9a-f]{64}$/)
		});
		admin.reachable = false;
		expect(await svc.status()).toMatchObject({
			reachable: false,
			configHash: null,
			drift: { state: 'unknown' }
		});
	});

	it('upstreams() names the sites that proxy to each upstream', async () => {
		const ups = await svc.upstreams();
		expect(ups).toEqual([
			{ address: '10.0.0.20:8096', numRequests: 2, fails: 0, sites: [{ hosts: ['media.home.localhost'] }] }
		]);
	});
});

describe('format on save', () => {
	const fmtParser =
		(fmt: (t: string) => string = format) =>
		() => ({
			parse: () => ({ cst: null, diagnostics: [] }),
			format: fmt
		});
	// Spaces for tabs, a run of blank lines and trailing whitespace: what a hand edit often looks like. (Trailing
	// whitespace after a directive: caddy fmt keeps it inside a comment, so format() does too.)
	const messy = SAMPLE.replace(/\t/g, '    ')
		.replace('# Media\n', '\n\n\n# Media\n')
		.replace('10.0.0.20:8096\n', '10.0.0.20:8096   \n');

	it('writes the caddy fmt form, returns it, and saving it again changes nothing', async () => {
		const fmt = make({ parser: fmtParser() });
		await fmt.init();
		const res = await fmt.apply(messy, { author: 'david' });
		expect(res).toMatchObject({
			changed: false,
			written: false,
			loaded: false,
			formatted: true,
			text: SAMPLE
		});
		const edited = messy.replace('10.0.0.20:8096', '10.0.0.20:8097');
		const res2 = await fmt.apply(edited, { author: 'david' });
		expect(res2).toMatchObject({ changed: true, written: true, loaded: true, formatted: true });
		expect(await readFile(file, 'utf8')).toBe(SAMPLE.replace('10.0.0.20:8096', '10.0.0.20:8097'));
		expect(res2.hash).toBe(sha256(res2.text));
		const again = await fmt.apply(res2.text, { author: 'david' });
		expect(again).toMatchObject({ changed: false, written: false, loaded: false, formatted: false });
	});

	it('formats a file whose only difference is layout without reloading Caddy', async () => {
		await writeFile(file, messy);
		const fmt = make({ parser: fmtParser() });
		await fmt.init();
		const res = await fmt.apply(messy, { author: 'david' });
		expect(res).toMatchObject({ changed: true, written: true, loaded: false, formatted: true });
		expect(await readFile(file, 'utf8')).toBe(SAMPLE);
		expect(admin.loads).toHaveLength(0);
	});

	it('reports errors on the lines of the text as sent, not the formatted text', async () => {
		const fmt = make({ parser: fmtParser() });
		const bad = '\n\n\n' + SAMPLE + 'bogus\n';
		const err = await applyError(fmt.apply(bad, { author: 'david' }));
		expect(err.body.diagnostics[0]).toMatchObject({ line: 91 });
	});

	it('saves the text as sent, with a warning, when formatting would change the config', async () => {
		const fmt = make({ parser: fmtParser((t) => t.replace('10.0.0.20:8096', '10.0.0.20:1')) });
		const next = SAMPLE + '# note\n';
		const res = await fmt.apply(next, { author: 'david' });
		expect(res).toMatchObject({ written: true, formatted: false, text: next });
		expect(res.diagnostics).toContainEqual(
			expect.objectContaining({ severity: 'warning', source: 'service' })
		);
		expect(await readFile(file, 'utf8')).toBe(next);
	});

	it('saves the text as sent when the formatter throws', async () => {
		const fmt = make({
			parser: fmtParser(() => {
				throw new Error('boom');
			})
		});
		const res = await fmt.apply(SAMPLE + '#x\n', { author: 'david' });
		expect(res).toMatchObject({ formatted: false, text: SAMPLE + '#x\n' });
		expect(res.diagnostics[0]?.message).toMatch(/formatter failed: boom/);
	});

	it('can be switched off', async () => {
		const plain = make({ parser: fmtParser(), formatOnSave: false });
		const res = await plain.apply(messy, { author: 'david' });
		expect(res).toMatchObject({ written: true, formatted: false, text: messy });
	});

	it('restoring an old unformatted revision writes its formatted form', async () => {
		await writeFile(file, messy);
		const fmt = make({ parser: fmtParser() });
		await fmt.init();
		const first = fmt.listRevisions()[0]!.id;
		await fmt.apply(SAMPLE.replace('8096', '8097'), { author: 'david' });
		const res = await fmt.restore(first, 'david');
		expect(res).toMatchObject({ written: true, formatted: true, text: SAMPLE });
	});
});
