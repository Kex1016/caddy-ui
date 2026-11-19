import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '$lib/server/db';
import { installSettings, onSettingsChange, resetSettingsForTests } from '$lib/server/settings';
import { readControl } from './channel';
import { checkNow, syncUpdaterInterval, updateKeyChanged } from './index';

// The Settings save for the update interval reaches the updater's control.json, and a reset hands the choice
// back to the updater's environment.

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'caddy-ui-updater-'));
	const service = installSettings({
		db: openDb(':memory:'),
		env: { CADDY_UI_AUTH_MODE: 'forward', CADDY_UI_UPDATER_DIR: dir }
	});
	onSettingsChange((_n, _p, changed) => {
		if (updateKeyChanged(changed)) syncUpdaterInterval();
	});
	expect(service).toBeTruthy();
});
afterEach(() => {
	resetSettingsForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe('update interval and check now', () => {
	it('writes nothing while nothing is saved', () => {
		syncUpdaterInterval();
		expect(readControl(dir)).toMatchObject({ interval: null, writtenAt: '' });
	});

	it('passes a saved interval on, applies it as the effective one, and takes it back on reset', async () => {
		const { getSettings } = await import('$lib/server/settings');
		const { config } = await import('$lib/server/env');
		getSettings().update({ CADDY_UI_UPDATE_INTERVAL: '5m' }, 'david');
		expect(readControl(dir).interval).toBe('5m');
		expect(config().updateIntervalMs).toBe(300_000);
		getSettings().update({ CADDY_UI_UPDATE_INTERVAL: null }, 'david');
		expect(readControl(dir).interval).toBeNull();
		expect(config().updateIntervalMs).toBe(3_600_000);
	});

	it('refuses an interval the updater would not understand', async () => {
		const { getSettings } = await import('$lib/server/settings');
		for (const bad of ['10s', '1h30m', 'often']) {
			expect(() => getSettings().update({ CADDY_UI_UPDATE_INTERVAL: bad }, 'david')).toThrow();
		}
		expect(readControl(dir).interval).toBeNull();
	});

	it('check now leaves the interval alone', async () => {
		const { getSettings } = await import('$lib/server/settings');
		getSettings().update({ CADDY_UI_UPDATE_INTERVAL: '2h' }, 'david');
		const token = checkNow();
		expect(readControl(dir)).toMatchObject({ interval: '2h', checkNow: token });
	});
});
