import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsError, SettingsView } from '$lib/api/settings';
import { openDb } from '$lib/server/db';
import { installSettings, resetSettingsForTests } from '$lib/server/settings';
import { GET, PATCH } from './+server';

type Handler = (e: never) => Response | Promise<Response>;
const call = (h: Handler, init: { method?: string; body?: string } = {}) => {
	const url = new URL('http://localhost/api/settings');
	return h({
		url,
		locals: { identity: { user: 'david', via: 'forward' } },
		request: new Request(url, { method: init.method ?? 'GET', body: init.body })
	} as never);
};
const patch = (body: unknown) =>
	call(PATCH as Handler, { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeEach(() => {
	installSettings({
		db: openDb(':memory:'),
		env: { CADDY_UI_AUTH_MODE: 'forward', PORKBUN_API_KEY: 'pk1_x' }
	});
});
afterEach(() => resetSettingsForTests());

describe('/api/settings', () => {
	it('GET lists every setting with its source, without secrets', async () => {
		const res = await call(GET as Handler);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = (await res.json()) as SettingsView;
		expect(body.signIn).toBe(true);
		expect(body.ignoringSaved).toBe(false);
		expect(body.settings.filter((r) => r.editable).map((r) => r.key)).toEqual([
			'CADDY_UI_PROBE_INTERVAL',
			'CADDY_UI_SCRAPE_INTERVAL',
			'CADDY_UI_RETENTION_DAYS',
			'TZ',
			'CADDY_UI_PUBLIC_URL',
			'CADDY_UI_PORKBUN_READONLY',
			'CADDY_UI_PORKBUN_CACHE_TTL',
			'CADDY_UI_CERT_WARN_DAYS',
			'CADDY_UI_PROBE_TIMEOUT',
			'CADDY_UI_REVISIONS_KEEP',
			'CADDY_UI_BACKUPS_KEEP',
			'CADDY_UI_UPDATE_INTERVAL',
			'CADDY_UI_LOG_EXCLUDE_NETWORKS'
		]);
		expect(JSON.stringify(body)).not.toContain('pk1_x');
	});

	it('PATCH saves, logs the author and answers with the new view', async () => {
		const res = await patch({ CADDY_UI_PROBE_INTERVAL: '1m', CADDY_UI_RETENTION_DAYS: 30 });
		expect(res.status).toBe(200);
		const body = (await res.json()) as SettingsView;
		expect(body.settings.find((r) => r.key === 'CADDY_UI_RETENTION_DAYS')).toMatchObject({
			value: '30',
			source: 'saved'
		});
		expect(body.log.map((l) => [l.author, l.key])).toEqual([
			['david', 'CADDY_UI_RETENTION_DAYS'],
			['david', 'CADDY_UI_PROBE_INTERVAL']
		]);
		const reset = (await (await patch({ CADDY_UI_PROBE_INTERVAL: null })).json()) as SettingsView;
		expect(reset.settings.find((r) => r.key === 'CADDY_UI_PROBE_INTERVAL')).toMatchObject({
			source: 'default'
		});
	});

	it('PATCH answers 400 with a message per key, and for a body that is not JSON', async () => {
		const res = await patch({ CADDY_UI_SCRAPE_INTERVAL: 'often' });
		expect(res.status).toBe(400);
		const body = (await res.json()) as SettingsError;
		expect(body.code).toBe('INVALID');
		expect(body.errors?.CADDY_UI_SCRAPE_INTERVAL).toMatch(/must be a duration/);
		expect((await patch('not json')).status).toBe(400);
		expect((await patch({ CADDYFILE_PATH: '/tmp/x' })).status).toBe(400);
	});

	it('PATCH answers 403 when loosening Porkbun without a sign-in', async () => {
		resetSettingsForTests();
		installSettings({ db: openDb(':memory:'), env: { CADDY_UI_AUTH_MODE: 'none' } });
		const res = await patch({ CADDY_UI_PORKBUN_READONLY: false });
		expect(res.status).toBe(403);
		expect(((await res.json()) as SettingsError).code).toBe('NEEDS_SIGN_IN');
	});
});
