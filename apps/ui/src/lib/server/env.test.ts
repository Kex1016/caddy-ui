import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './env';

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
			timeZone: 'UTC'
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
		['TZ', 'Mars/Olympus']
	])('rejects %s=%s naming the variable', (name, value) => {
		expect(() => loadConfig({ [name]: value })).toThrowError(ConfigError);
		expect(() => loadConfig({ [name]: value })).toThrowError(name);
	});
});
