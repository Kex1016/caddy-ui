import { describe, expect, it } from 'vitest';
import { ConfigError, checkSetting, loadConfig } from './env';

describe('loadConfig', () => {
	it('uses the PLAN.md defaults with an empty environment', () => {
		expect(loadConfig({})).toEqual({
			port: 3001,
			adminUrl: 'http://caddy:2019',
			caddyfilePath: '/etc/caddy/Caddyfile',
			logPath: '/var/log/caddy/access.log',
			dataPath: '/data/caddy',
			uiData: '/etc/caddy-ui',
			user: undefined,
			password: undefined,
			authMode: 'local',
			sessionSecret: undefined,
			probeIntervalMs: 30_000,
			scrapeIntervalMs: 15_000,
			retentionDays: 90,
			publicUrl: undefined,
			updateIntervalMs: 3_600_000,
			updateWebhookPort: undefined,
			updateSource: 'ghcr',
			timeZone: 'UTC',
			porkbun: {
				apiKey: undefined,
				apiSecret: undefined,
				apiUrl: 'https://api.porkbun.com/api/json/v3',
				readonly: true,
				cacheTtlMs: 60_000,
				sslKeyDownload: false
			},
			settingsIgnore: false
		});
	});

	it('reads every variable', () => {
		const cfg = loadConfig({
			CADDY_UI_PORT: '9000',
			CADDY_ADMIN_URL: 'http://localhost:2019/',
			CADDYFILE_PATH: '/srv/Caddyfile',
			CADDY_UI_USER: 'admin',
			CADDY_UI_PASSWORD: 'pw',
			CADDY_UI_AUTH_MODE: 'Forward',
			CADDY_UI_PROBE_INTERVAL: '1m',
			CADDY_UI_RETENTION_DAYS: '30',
			CADDY_UI_PUBLIC_URL: 'https://caddy.example.com',
			CADDY_UI_UPDATE_WEBHOOK_PORT: '9100',
			CADDY_UI_UPDATE_SOURCE: 'git',
			TZ: 'Europe/Budapest'
		});
		expect(cfg).toMatchObject({
			port: 9000,
			adminUrl: 'http://localhost:2019',
			caddyfilePath: '/srv/Caddyfile',
			user: 'admin',
			password: 'pw',
			authMode: 'forward',
			probeIntervalMs: 60_000,
			retentionDays: 30,
			publicUrl: 'https://caddy.example.com',
			updateWebhookPort: 9100,
			updateSource: 'git',
			timeZone: 'Europe/Budapest'
		});
	});

	it('treats empty strings as unset', () => {
		const cfg = loadConfig({ CADDY_UI_USER: '', CADDY_UI_PORT: '', CADDY_UI_AUTH_MODE: '' });
		expect(cfg.user).toBeUndefined();
		expect(cfg.port).toBe(3001);
		expect(cfg.authMode).toBe('local');
	});

	it.each([
		['CADDY_UI_PORT', 'abc'],
		['CADDY_UI_PORT', '70000'],
		['CADDY_UI_AUTH_MODE', 'oauth'],
		['CADDY_UI_PROBE_INTERVAL', 'soon'],
		['CADDY_UI_PROBE_INTERVAL', '100ms'],
		['CADDY_UI_UPDATE_INTERVAL', '10s'],
		['CADDY_ADMIN_URL', 'caddy:2019'],
		['CADDY_UI_UPDATE_SOURCE', 'dockerhub'],
		['PORKBUN_API_URL', 'api.porkbun.com'],
		['CADDY_UI_PORKBUN_READONLY', 'maybe'],
		['CADDY_UI_PORKBUN_CACHE_TTL', 'a while'],
		['CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD', '2'],
		['TZ', 'Mars/Olympus']
	])('rejects %s=%s naming the variable', (name, value) => {
		expect(() => loadConfig({ [name]: value })).toThrowError(ConfigError);
		expect(() => loadConfig({ [name]: value })).toThrowError(name);
	});

	describe('Porkbun', () => {
		it('reads the keys, trimmed, and treats empty or blank ones as unset', () => {
			const cfg = loadConfig({ PORKBUN_API_KEY: ' pk1_abc\n', PORKBUN_API_SECRET_KEY: 'sk1_def' });
			expect(cfg.porkbun.apiKey).toBe('pk1_abc');
			expect(cfg.porkbun.apiSecret).toBe('sk1_def');
			const empty = loadConfig({ PORKBUN_API_KEY: '', PORKBUN_API_SECRET_KEY: '   ' });
			expect(empty.porkbun.apiKey).toBeUndefined();
			expect(empty.porkbun.apiSecret).toBeUndefined();
		});

		it('reads the other settings', () => {
			const cfg = loadConfig({
				PORKBUN_API_URL: 'https://api-ipv4.porkbun.com/api/json/v3/',
				CADDY_UI_PORKBUN_CACHE_TTL: '5m',
				CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD: 'TRUE',
				CADDY_UI_PORKBUN_READONLY: 'yes',
				CADDY_UI_AUTH_MODE: 'forward'
			});
			expect(cfg.porkbun).toMatchObject({
				apiUrl: 'https://api-ipv4.porkbun.com/api/json/v3',
				cacheTtlMs: 300_000,
				sslKeyDownload: true,
				readonly: true
			});
			expect(loadConfig({ CADDY_UI_PORKBUN_CACHE_TTL: '0s' }).porkbun.cacheTtlMs).toBe(0);
		});

		it.each([
			[{ CADDY_UI_AUTH_MODE: 'none' }, true],
			[{}, true],
			[{ CADDY_UI_USER: 'admin', CADDY_UI_PASSWORD: 'pw' }, false],
			[{ CADDY_UI_USER: 'admin' }, false],
			[{ CADDY_UI_AUTH_MODE: 'forward' }, false],
			[{ CADDY_UI_AUTH_MODE: 'none', CADDY_UI_PORKBUN_READONLY: 'false' }, false],
			[{ CADDY_UI_AUTH_MODE: 'forward', CADDY_UI_PORKBUN_READONLY: 'true' }, true]
		])('is read-only by default only when nobody has to sign in: %o', (env, readonly) => {
			expect(loadConfig(env).porkbun.readonly).toBe(readonly);
		});
	});
});

describe('checkSetting', () => {
	it('uses the same parsers and messages as loadConfig', () => {
		expect(checkSetting('CADDY_UI_PROBE_INTERVAL', ' 2m ')).toBe('2m');
		expect(() => checkSetting('CADDY_UI_PROBE_INTERVAL', '500ms')).toThrow(
			'CADDY_UI_PROBE_INTERVAL must be at least 1s, got "500ms"'
		);
		expect(() => checkSetting('CADDY_UI_RETENTION_DAYS', '9.5')).toThrow(/whole number/);
		expect(() => checkSetting('CADDY_UI_PORKBUN_READONLY', 'maybe')).toThrow(/true or false/);
		expect(() => checkSetting('CADDY_UI_PUBLIC_URL', 'ftp://x')).toThrow(/http\(s\) URL/);
		expect(checkSetting('CADDY_UI_PUBLIC_URL', '')).toBe('');
		expect(() => checkSetting('TZ', '')).toThrow(/must not be empty/);
		expect(checkSetting('CADDY_UI_PORKBUN_CACHE_TTL', '0s')).toBe('0s');
	});

	it('CADDY_UI_SETTINGS_IGNORE is a strict boolean', () => {
		expect(loadConfig({ CADDY_UI_SETTINGS_IGNORE: 'true' }).settingsIgnore).toBe(true);
		expect(() => loadConfig({ CADDY_UI_SETTINGS_IGNORE: 'please' })).toThrow(/CADDY_UI_SETTINGS_IGNORE/);
	});
});
