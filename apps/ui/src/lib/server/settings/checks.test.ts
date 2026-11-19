import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../env';
import { pathChecks } from './checks';

/** Health checks for the environment's paths (docs/settings-and-perf-plan.md §2.1). */

let dir = '';
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = '';
});

function setup() {
	dir = mkdtempSync(join(tmpdir(), 'caddy-ui-checks-'));
	writeFileSync(join(dir, 'Caddyfile'), ':80\n');
	writeFileSync(join(dir, 'access.log'), '');
	mkdirSync(join(dir, 'caddy-data'));
	mkdirSync(join(dir, 'ui'));
	return loadConfig({
		CADDYFILE_PATH: join(dir, 'Caddyfile'),
		CADDY_LOG_PATH: join(dir, 'access.log'),
		CADDY_DATA_PATH: join(dir, 'caddy-data'),
		CADDY_UI_DATA: join(dir, 'ui')
	});
}

const byKey = (cfg: ReturnType<typeof setup>) => Object.fromEntries(pathChecks(cfg).map((c) => [c.key, c]));

describe('pathChecks', () => {
	it('passes every path that is there with the access the UI needs', () => {
		const c = byKey(setup());
		expect(Object.values(c).map((x) => x.state)).toEqual(['ok', 'ok', 'ok', 'ok']);
	});

	it('warns about a missing access log or data directory, and fails a missing Caddyfile', () => {
		const cfg = setup();
		rmSync(cfg.logPath);
		rmSync(cfg.dataPath, { recursive: true });
		rmSync(cfg.caddyfilePath);
		const c = byKey(cfg);
		expect(c.CADDY_LOG_PATH?.state).toBe('warning');
		expect(c.CADDY_DATA_PATH?.state).toBe('warning');
		expect(c.CADDYFILE_PATH?.state).toBe('error');
		expect(c.CADDYFILE_PATH?.message).toMatch(/Not found/);
	});

	it('fails a path of the wrong kind', () => {
		const cfg = setup();
		const c = byKey({ ...cfg, caddyfilePath: cfg.dataPath, uiData: cfg.caddyfilePath });
		expect(c.CADDYFILE_PATH?.message).toMatch(/not a file/);
		expect(c.CADDY_UI_DATA?.message).toMatch(/not a directory/);
	});

	it.skipIf(process.getuid?.() === 0)('fails a Caddyfile the UI cannot write', () => {
		const cfg = setup();
		chmodSync(cfg.caddyfilePath, 0o444);
		const c = byKey(cfg);
		expect(c.CADDYFILE_PATH?.state).toBe('error');
		expect(c.CADDYFILE_PATH?.message).toMatch(/not writable/);
	});
});
