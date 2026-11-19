import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditableSetting, EnvOnlySetting } from '$lib/api/settings';
import { openDb, type Db } from '../db';
import { config } from '../env';
import { installSettings, onSettingsChange, resetSettingsForTests } from '.';
import { KEY_PREFIX, SettingsRefused, SettingsService } from './service';

/** The settings service (docs/settings-and-perf-plan.md §2.2, D7–D11, D16, D17). */

type Env = Record<string, string | undefined>;
const SIGNED_IN: Env = { CADDY_UI_AUTH_MODE: 'forward' };
const OPEN: Env = { CADDY_UI_AUTH_MODE: 'none' };

const make = (env: Env = SIGNED_IN, db: Db = openDb(':memory:')) => ({ db, s: new SettingsService(db, env) });
const row = (s: SettingsService, key: string) =>
	s.view().settings.find((r) => r.key === key) as EditableSetting & EnvOnlySetting;
const saveRaw = (db: Db, key: string, value: string) =>
	db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KEY_PREFIX + key, value);
function refused(fn: () => unknown): SettingsRefused {
	try {
		fn();
	} catch (err) {
		if (err instanceof SettingsRefused) return err;
		throw err;
	}
	throw new Error('expected SettingsRefused');
}

afterEach(() => resetSettingsForTests());

describe('precedence: saved, then environment, then default', () => {
	it('uses the default when nothing is set', () => {
		const { s } = make();
		expect(s.config().probeIntervalMs).toBe(30_000);
		expect(row(s, 'CADDY_UI_PROBE_INTERVAL')).toMatchObject({
			value: '30s',
			source: 'default',
			env: null,
			default: '30s',
			saved: null,
			editable: true
		});
	});

	it('uses the environment over the default', () => {
		const { s } = make({ ...SIGNED_IN, CADDY_UI_PROBE_INTERVAL: '45s' });
		expect(s.config().probeIntervalMs).toBe(45_000);
		expect(row(s, 'CADDY_UI_PROBE_INTERVAL')).toMatchObject({ value: '45s', source: 'env', env: '45s' });
	});

	it('uses a saved value over the environment, and the environment again once it is removed', () => {
		const { s } = make({ ...SIGNED_IN, CADDY_UI_PROBE_INTERVAL: '45s', TZ: 'Europe/Budapest' });
		s.update({ CADDY_UI_PROBE_INTERVAL: '2m', CADDY_UI_RETENTION_DAYS: 30, TZ: 'Asia/Tokyo' }, 'david');
		expect(s.config()).toMatchObject({ probeIntervalMs: 120_000, retentionDays: 30, timeZone: 'Asia/Tokyo' });
		expect(row(s, 'CADDY_UI_PROBE_INTERVAL')).toMatchObject({
			value: '2m',
			source: 'saved',
			env: '45s',
			saved: '2m'
		});
		s.update({ CADDY_UI_PROBE_INTERVAL: null, TZ: null }, 'david');
		expect(s.config().probeIntervalMs).toBe(45_000);
		expect(s.config().timeZone).toBe('Europe/Budapest');
		expect(row(s, 'CADDY_UI_PROBE_INTERVAL')).toMatchObject({ source: 'env', saved: null });
	});

	it('keeps saved values across a restart (a new service on the same database)', () => {
		const { db, s } = make();
		s.update({ CADDY_UI_PORKBUN_CACHE_TTL: '5m', CADDY_UI_PUBLIC_URL: 'https://ui.example.com/' }, 'david');
		const again = new SettingsService(db, SIGNED_IN);
		expect(again.config().porkbun.cacheTtlMs).toBe(300_000);
		expect(again.config().publicUrl).toBe('https://ui.example.com');
	});

	it('can clear CADDY_UI_PUBLIC_URL that the environment sets, and nothing else can be empty', () => {
		const { s } = make({ ...SIGNED_IN, CADDY_UI_PUBLIC_URL: 'https://env.example.com' });
		s.update({ CADDY_UI_PUBLIC_URL: '' }, 'david');
		expect(s.config().publicUrl).toBeUndefined();
		expect(row(s, 'CADDY_UI_PUBLIC_URL')).toMatchObject({ source: 'saved', value: null });
		const err = refused(() => s.update({ TZ: '  ' }, 'david'));
		expect(err.body.errors?.TZ).toMatch(/must not be empty/);
	});

	it('takes only the seven editable fields from the overlay; the rest stays the environment’s', () => {
		const { s } = make({ ...SIGNED_IN, CADDY_ADMIN_URL: 'http://caddy:2019' });
		s.update({ CADDY_UI_SCRAPE_INTERVAL: '1m' }, 'david');
		expect(s.config().adminUrl).toBe('http://caddy:2019');
		expect(s.config().authMode).toBe('forward');
		expect(s.config().scrapeIntervalMs).toBe(60_000);
	});
});

describe('validation', () => {
	it('checks with the environment parsers, so the messages match', () => {
		const { s } = make();
		const err = refused(() =>
			s.update({ CADDY_UI_PROBE_INTERVAL: 'soon', CADDY_UI_RETENTION_DAYS: '0', TZ: 'Mars/Base' }, 'david')
		);
		expect(err.status).toBe(400);
		expect(err.body.code).toBe('INVALID');
		expect(err.body.errors).toEqual({
			CADDY_UI_PROBE_INTERVAL: 'CADDY_UI_PROBE_INTERVAL must be a duration such as 30s, 5m or 1h, got "soon"',
			CADDY_UI_RETENTION_DAYS: 'CADDY_UI_RETENTION_DAYS must be between 1 and 36500, got 0',
			TZ: 'TZ must be an IANA time zone such as Europe/Budapest, got "Mars/Base"'
		});
	});

	it('saves nothing when any key fails', () => {
		const { db, s } = make();
		refused(() => s.update({ CADDY_UI_PROBE_INTERVAL: '1m', CADDY_UI_SCRAPE_INTERVAL: '0s' }, 'david'));
		expect(s.config().probeIntervalMs).toBe(30_000);
		expect(db.prepare('SELECT count(*) AS n FROM settings_log').get()).toEqual({ n: 0 });
	});

	it('refuses environment-only and unknown keys, and odd value types', () => {
		const { s } = make();
		expect(refused(() => s.update({ CADDY_ADMIN_URL: 'http://x:2019' }, 'd')).body.code).toBe('NOT_EDITABLE');
		expect(refused(() => s.update({ PORKBUN_API_KEY: 'pk1_x' }, 'd')).body.code).toBe('NOT_EDITABLE');
		expect(refused(() => s.update({ CADDY_UI_PORT: '1' }, 'd')).body.code).toBe('NOT_EDITABLE');
		expect(refused(() => s.update({ NOPE: '1' }, 'd')).body.code).toBe('UNKNOWN_KEY');
		expect(refused(() => s.update({}, 'd')).body.code).toBe('INVALID');
		expect(
			refused(() => s.update({ TZ: { a: 1 } } as unknown as Record<string, string>, 'd')).body.code
		).toBe('INVALID');
		expect(refused(() => s.update([] as unknown as Record<string, string>, 'd')).body.code).toBe('INVALID');
	});
});

describe('bad saved values', () => {
	it('ignores a saved value that no longer passes, with a warning, and never throws', () => {
		const db = openDb(':memory:');
		saveRaw(db, 'CADDY_UI_PROBE_INTERVAL', 'fortnightly');
		saveRaw(db, 'CADDY_UI_RETENTION_DAYS', '7');
		saveRaw(db, 'CADDY_UI_SOMETHING_FROM_A_NEWER_BUILD', 'x');
		const s = new SettingsService(db, { ...SIGNED_IN, CADDY_UI_PROBE_INTERVAL: '20s' });
		expect(s.config().probeIntervalMs).toBe(20_000);
		expect(s.config().retentionDays).toBe(7);
		expect(s.warnings()).toEqual([
			{
				key: 'CADDY_UI_PROBE_INTERVAL',
				message: expect.stringMatching(/saved value "fortnightly" is ignored: .*must be a duration/)
			}
		]);
		expect(row(s, 'CADDY_UI_PROBE_INTERVAL')).toMatchObject({
			source: 'env',
			value: '20s',
			saved: 'fortnightly',
			ignoredReason: expect.stringContaining('ignored')
		});
	});

	it('logs ignored values at boot through installSettings', () => {
		const db = openDb(':memory:');
		saveRaw(db, 'TZ', 'Nowhere/Land');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		installSettings({ db, env: SIGNED_IN });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('setting TZ: The saved value "Nowhere/Land"'));
		expect(config().timeZone).toBe('UTC');
		warn.mockRestore();
	});
});

describe('Porkbun read-only guard', () => {
	it('defaults to read-only without a sign-in and refuses to turn it off from the UI', () => {
		const { s } = make(OPEN);
		expect(s.config().porkbun.readonly).toBe(true);
		expect(row(s, 'CADDY_UI_PORKBUN_READONLY')).toMatchObject({ value: 'true', source: 'default' });
		const err = refused(() => s.update({ CADDY_UI_PORKBUN_READONLY: false }, 'admin'));
		expect(err.status).toBe(403);
		expect(err.body.code).toBe('NEEDS_SIGN_IN');
		expect(refused(() => s.update({ CADDY_UI_PORKBUN_READONLY: 'off' }, 'admin')).status).toBe(403);
	});

	it('can always be turned on, with or without a sign-in', () => {
		const open = make({ ...OPEN, CADDY_UI_PORKBUN_READONLY: 'false' }).s;
		expect(open.config().porkbun.readonly).toBe(false); // the environment's call, as before
		open.update({ CADDY_UI_PORKBUN_READONLY: true }, 'admin');
		expect(open.config().porkbun.readonly).toBe(true);
	});

	it('can be turned off with forward auth or a local user', () => {
		for (const env of [SIGNED_IN, { CADDY_UI_USER: 'david', CADDY_UI_PASSWORD: 'pw' }]) {
			const { s } = make({ ...env, CADDY_UI_PORKBUN_READONLY: 'true' });
			s.update({ CADDY_UI_PORKBUN_READONLY: 'false' }, 'david');
			expect(s.config().porkbun.readonly).toBe(false);
		}
	});

	it('local mode with no user counts as no sign-in', () => {
		const { s } = make({});
		expect(s.signIn).toBe(false);
		expect(refused(() => s.update({ CADDY_UI_PORKBUN_READONLY: 'false' }, 'admin')).status).toBe(403);
	});

	it('ignores a saved "off" once the sign-in is gone', () => {
		const db = openDb(':memory:');
		new SettingsService(db, SIGNED_IN).update({ CADDY_UI_PORKBUN_READONLY: 'false' }, 'david');
		const s = new SettingsService(db, OPEN);
		expect(s.config().porkbun.readonly).toBe(true);
		expect(s.warnings()[0]).toMatchObject({ key: 'CADDY_UI_PORKBUN_READONLY' });
		expect(s.warnings()[0]?.message).toMatch(/needs a sign-in/);
	});
});

describe('CADDY_UI_SETTINGS_IGNORE', () => {
	it('runs on environment and defaults only, keeps the saved values, and refuses new ones', () => {
		const db = openDb(':memory:');
		new SettingsService(db, SIGNED_IN).update({ CADDY_UI_PROBE_INTERVAL: '5m', TZ: 'Asia/Tokyo' }, 'david');
		const s = new SettingsService(db, {
			...SIGNED_IN,
			CADDY_UI_SETTINGS_IGNORE: 'true',
			TZ: 'Europe/Budapest'
		});
		expect(s.ignoringSaved).toBe(true);
		expect(s.config().probeIntervalMs).toBe(30_000);
		expect(s.config().timeZone).toBe('Europe/Budapest');
		expect(s.view().ignoringSaved).toBe(true);
		expect(row(s, 'CADDY_UI_PROBE_INTERVAL')).toMatchObject({ source: 'default', saved: '5m' });
		expect(s.warnings()).toHaveLength(2);

		const err = refused(() => s.update({ CADDY_UI_PROBE_INTERVAL: '1m' }, 'david'));
		expect(err.status).toBe(409);
		expect(err.body.code).toBe('SETTINGS_IGNORED');
		// Resetting still works: it is how a bad value is cleared.
		s.update({ TZ: null }, 'david');
		expect(new SettingsService(db, SIGNED_IN).config().timeZone).toBe('UTC');
		expect(new SettingsService(db, SIGNED_IN).config().probeIntervalMs).toBe(300_000);
	});
});

describe('settings log', () => {
	it('records who changed what, with the old and new saved values', () => {
		let t = 1_000;
		const db = openDb(':memory:');
		const s = new SettingsService(db, SIGNED_IN, { now: () => t });
		s.update({ CADDY_UI_PROBE_INTERVAL: '1m' }, 'david');
		t = 2_000;
		s.update({ CADDY_UI_PROBE_INTERVAL: '2m' }, 'tinyauth-user');
		t = 3_000;
		s.update({ CADDY_UI_PROBE_INTERVAL: '2m' }, 'david'); // no change, no row
		s.update({ CADDY_UI_PROBE_INTERVAL: null }, 'david');
		expect(s.log().map(({ id: _id, ...r }) => r)).toEqual([
			{ ts: 3_000, author: 'david', key: 'CADDY_UI_PROBE_INTERVAL', oldValue: '2m', newValue: null },
			{ ts: 2_000, author: 'tinyauth-user', key: 'CADDY_UI_PROBE_INTERVAL', oldValue: '1m', newValue: '2m' },
			{ ts: 1_000, author: 'david', key: 'CADDY_UI_PROBE_INTERVAL', oldValue: null, newValue: '1m' }
		]);
		expect(s.view().log).toHaveLength(3);
	});
});

describe('subscribers', () => {
	it('are told which values changed in effect, and only then', () => {
		const { s } = make({ ...SIGNED_IN, CADDY_UI_PROBE_INTERVAL: '1m' });
		const seen: string[][] = [];
		const off = s.subscribe((next, prev, changed) => {
			seen.push(changed);
			expect(next).not.toBe(prev);
		});
		s.update({ CADDY_UI_PROBE_INTERVAL: '60s' }, 'david'); // saved, but the same interval
		s.update({ CADDY_UI_PROBE_INTERVAL: '2m', CADDY_UI_PORKBUN_CACHE_TTL: '10s' }, 'david');
		off();
		s.update({ TZ: 'Asia/Tokyo' }, 'david');
		expect(seen).toEqual([['CADDY_UI_PROBE_INTERVAL', 'CADDY_UI_PORKBUN_CACHE_TTL']]);
	});

	it('a failing subscriber does not stop the others or the save', () => {
		const { s } = make();
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const second = vi.fn();
		s.subscribe(() => {
			throw new Error('boom');
		});
		s.subscribe(second);
		s.update({ CADDY_UI_SCRAPE_INTERVAL: '1m' }, 'david');
		expect(second).toHaveBeenCalledOnce();
		expect(s.config().scrapeIntervalMs).toBe(60_000);
		err.mockRestore();
	});
});

describe('config() and secrets', () => {
	it('config() returns the effective config once installed, without touching process.env', () => {
		const before = process.env.TZ;
		const db = openDb(':memory:');
		const s = installSettings({ db, env: SIGNED_IN });
		const changed = vi.fn();
		onSettingsChange(changed);
		s.update({ TZ: 'America/New_York', CADDY_UI_PUBLIC_URL: 'https://ui.example.com' }, 'david');
		expect(config().timeZone).toBe('America/New_York');
		expect(config().publicUrl).toBe('https://ui.example.com');
		expect(changed).toHaveBeenCalledOnce();
		expect(process.env.TZ).toBe(before);
		resetSettingsForTests();
		expect(config().timeZone).not.toBe('America/New_York');
	});

	it('never returns a secret, only whether it is set', () => {
		const env = {
			CADDY_UI_AUTH_MODE: 'local',
			CADDY_UI_USER: 'someone-unique-user',
			CADDY_UI_PASSWORD: 'pw-unique-0123',
			CADDY_UI_SESSION_SECRET: 'sess-unique-4567',
			PORKBUN_API_KEY: 'pk1_unique_89ab',
			PORKBUN_API_SECRET_KEY: 'sk1_unique_cdef'
		};
		const { s } = make(env);
		const text = JSON.stringify(s.view());
		for (const v of Object.values(env).slice(1)) expect(text).not.toContain(v);
		expect(row(s, 'PORKBUN_API_KEY')).toEqual({
			key: 'PORKBUN_API_KEY',
			editable: false,
			source: 'env',
			secret: true,
			set: true
		});
		expect(row(s, 'CADDY_UI_SESSION_SECRET')).toMatchObject({ secret: true, set: true });
		expect(
			make({})
				.s.view()
				.settings.find((r) => r.key === 'PORKBUN_API_KEY')
		).toMatchObject({ set: false });
	});

	it('shows environment-only rows with their value in force', () => {
		const { s } = make({ ...SIGNED_IN, CADDY_ADMIN_URL: 'http://caddy:2019/' });
		expect(row(s, 'CADDY_ADMIN_URL')).toMatchObject({
			editable: false,
			source: 'env',
			value: 'http://caddy:2019',
			default: 'http://caddy:2019'
		});
		expect(row(s, 'CADDYFILE_PATH')).toMatchObject({ source: 'default', value: '/etc/caddy/Caddyfile' });
		expect(row(s, 'CADDY_UI_AUTH_MODE')).toMatchObject({ value: 'forward' });
	});
});
