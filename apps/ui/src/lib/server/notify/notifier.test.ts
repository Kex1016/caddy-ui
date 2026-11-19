import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventKind } from '$lib/notify/types';
import { defaultTemplate } from '$lib/notify/templates';
import { openDb, type Db } from '../db';
import { DiscordSender } from './discord';
import { startFakeDiscord, type FakeDiscord } from './fake-discord';
import { compareVersions, Notifier, NotifyRefused, type CycleEntry } from './notifier';
import { K } from './store';

// Made up; every request goes to the local fake (CADDY_UI_DISCORD_API_URL in production code).
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/fake-token-not-a-real-one-0123456789';
const MIN = 60_000;
const DAY = 86_400_000;
const SITES = [
	{ id: 's1', addresses: ['app.example.com'] },
	{ id: 's2', addresses: ['b.example.com', 'www.b.example.com'] }
];

let fake: FakeDiscord;
let db: Db;
let now: number;
let n: Notifier;

function make(opts: { version?: string; publicUrl?: string } = {}) {
	return new Notifier({
		db,
		sender: new DiscordSender({ apiBase: fake.url, sleep: async () => {} }),
		version: opts.version ?? '1.2.0',
		display: () => ({ timeZone: 'Europe/Budapest', publicUrl: opts.publicUrl ?? 'https://ui.example.com' }),
		now: () => now
	});
}

/** The text of every message the fake got, flattened, with its event read from the heading. */
const texts = () =>
	fake.messages.map((m) => {
		const parts: string[] = [];
		const walk = (x: unknown) => {
			if (Array.isArray(x)) x.forEach(walk);
			else if (x && typeof x === 'object') {
				const o = x as Record<string, unknown>;
				if (typeof o.content === 'string') parts.push(o.content);
				if (typeof o.title === 'string') parts.push(o.title);
				if (typeof o.description === 'string') parts.push(o.description);
				Object.values(o).forEach(walk);
			}
		};
		walk(m.body.components ?? m.body.embeds);
		return parts.join(' | ');
	});

const site = (
	siteId: string,
	state: CycleEntry['state'],
	status: number | null = null,
	error: string | null = null
) => ({
	siteId,
	target: '',
	state,
	status,
	error
});

async function cycle(entries: CycleEntry[], step = 30_000) {
	now += step;
	n.onCycle(now, entries, SITES);
	await n.idle();
}

beforeAll(async () => {
	fake = await startFakeDiscord();
});
afterAll(() => fake.close());
beforeEach(() => {
	fake.reset();
	db = openDb(':memory:');
	now = Date.UTC(2026, 10, 19, 10, 0);
	n = make();
	n.update({ webhook: WEBHOOK }, 'david');
});

describe('site down and back up', () => {
	it('sends "down" after two failed cycles in a row, not after one', async () => {
		await cycle([site('s1', 'up', 200)]);
		await cycle([site('s1', 'down', 502, 'HTTP 502')]);
		expect(fake.messages).toHaveLength(0);
		await cycle([site('s1', 'down', 502, 'HTTP 502')]);
		expect(texts()).toEqual([expect.stringContaining('### app.example.com is down')]);
		expect(texts()[0]).toContain('**Error:** HTTP 502');
		// The button links to the site's page.
		expect(JSON.stringify(fake.messages[0]?.body)).toContain('https://ui.example.com/sites/s1');
		await cycle([site('s1', 'down', 502, 'HTTP 502')]);
		expect(fake.messages).toHaveLength(1);
	});

	it('a single failed cycle between good ones sends nothing', async () => {
		await cycle([site('s1', 'down', null, 'timeout')]);
		await cycle([site('s1', 'up', 200)]);
		await cycle([site('s1', 'down', null, 'timeout')]);
		await cycle([site('s1', 'up', 200)]);
		expect(fake.messages).toHaveLength(0);
	});

	it('sends "back up" with how long it was down, from the first failure', async () => {
		await cycle([site('s1', 'down', null, 'ECONNREFUSED')]);
		await cycle([site('s1', 'down', null, 'ECONNREFUSED')]);
		await cycle([site('s1', 'up', 200)], 10 * MIN);
		expect(texts()).toHaveLength(2);
		expect(texts()[1]).toContain('### app.example.com is back up');
		expect(texts()[1]).toContain('Down for 10m');
		expect(texts()[1]).toContain('(HTTP 200)');
	});

	it('limits a flapping site to one message per window and then tells the last state', async () => {
		await cycle([site('s1', 'down')]);
		await cycle([site('s1', 'down')]); // "down" sent
		await cycle([site('s1', 'up', 200)]); // held: within 5 minutes of the last message
		await cycle([site('s1', 'down')]);
		await cycle([site('s1', 'down')]); // down again: matches what was told, nothing to send
		await cycle([site('s1', 'up', 200)]); // held
		expect(texts()).toEqual([expect.stringContaining('is down')]);
		await cycle([site('s1', 'up', 200)], 5 * MIN); // the window has passed and it is still up
		expect(texts()).toHaveLength(2);
		expect(texts()[1]).toContain('is back up');
	});

	it('names every address of a site', async () => {
		await cycle([site('s2', 'down')]);
		await cycle([site('s2', 'down')]);
		expect(texts()[0]).toContain('b.example.com, www.b.example.com is down');
	});

	it('does not repeat "down" after a restart, and still says when it is back', async () => {
		const states = new Map([['s1|', { state: 'down', since: now - 30 * MIN }]]);
		n.seed(states, SITES);
		await cycle([site('s1', 'down')]);
		await cycle([site('s1', 'down')]);
		expect(fake.messages).toHaveLength(0);
		await cycle([site('s1', 'up', 200)]);
		expect(texts()[0]).toContain('is back up');
		expect(texts()[0]).toContain('Down for 31m');
	});

	it('follows a changed threshold', async () => {
		n.update({ downCycles: 3, flapMinutes: 0 }, 'david');
		await cycle([site('s1', 'down')]);
		await cycle([site('s1', 'down')]);
		expect(fake.messages).toHaveLength(0);
		await cycle([site('s1', 'down')]);
		expect(fake.messages).toHaveLength(1);
	});

	it('sends nothing for an event that is off, or without a webhook', async () => {
		n.update({ events: { site_down: { ...defaultTemplate('site_down'), enabled: false } } }, 'david');
		await cycle([site('s1', 'down')]);
		await cycle([site('s1', 'down')]);
		expect(fake.messages).toHaveLength(0);
		n.update({ events: { site_down: null }, webhook: null }, 'david');
		await cycle([site('s1', 'up')]);
		await cycle([site('s1', 'down')]);
		await cycle([site('s1', 'down')]);
		expect(fake.messages).toHaveLength(0);
	});
});

describe('upstreams', () => {
	const up = (siteId: string, address: string, state: CycleEntry['state']) => ({
		siteId,
		target: address,
		state,
		status: null,
		error: state === 'down' ? 'ECONNREFUSED' : null
	});

	it('are off by default; switched on, one message per upstream names every site using it', async () => {
		await cycle([up('s1', '10.0.0.5:80', 'down'), up('s2', '10.0.0.5:80', 'down')]);
		await cycle([up('s1', '10.0.0.5:80', 'down'), up('s2', '10.0.0.5:80', 'down')]);
		expect(fake.messages).toHaveLength(0);

		n.update({ events: { upstream_down: { ...defaultTemplate('upstream_down'), enabled: true } } }, 'david');
		await cycle([up('s1', '10.0.0.6:80', 'down'), up('s2', '10.0.0.6:80', 'down')]);
		await cycle([up('s1', '10.0.0.6:80', 'down'), up('s2', '10.0.0.6:80', 'down')]);
		expect(texts()).toEqual([expect.stringContaining('Upstream 10.0.0.6:80 is down')]);
		expect(texts()[0]).toContain('Used by app.example.com, b.example.com, www.b.example.com.');
	});
});

describe('certificates', () => {
	const siteFor = (host: string) => (host === 'app.example.com' ? 's1' : undefined);

	it('warns once inside the window and once more with 3 days left, for sites in the Caddyfile only', async () => {
		const notAfter = now + 10 * DAY;
		const certs = [
			{ host: 'app.example.com', notAfter, issuer: 'Let’s Encrypt' },
			{ host: 'old.example.com', notAfter: now + DAY, issuer: 'Let’s Encrypt' }
		];
		n.onCerts(certs, siteFor);
		await n.idle();
		expect(texts()).toEqual([expect.stringContaining('Certificate for app.example.com expires in 10 days')]);
		n.onCerts(certs, siteFor);
		await n.idle();
		expect(fake.messages).toHaveLength(1);

		now += 8 * DAY;
		n = make(); // a restart in between does not warn again for the same stage
		n.onCerts(certs, siteFor);
		await n.idle();
		expect(texts()[1]).toContain('expires in 2 days');

		// A renewal (a later expiry) starts over and is quiet until it nears its own end.
		n.onCerts([{ ...certs[0]!, notAfter: now + 90 * DAY }], siteFor);
		await n.idle();
		expect(fake.messages).toHaveLength(2);
		expect(db.prepare(`SELECT value FROM settings WHERE key = ?`).get(K.certs)).toBeUndefined();
	});
});

describe('Caddyfile and versions', () => {
	it('announces an edit made outside the UI with its revision', async () => {
		n.onExternalEdit({ at: now, revisionId: 42 });
		await n.idle();
		expect(texts()[0]).toContain('Caddyfile changed outside the UI');
		expect(texts()[0]).toContain('revision #42'); // '#' is not escaped
		expect(JSON.stringify(fake.messages[0]?.body)).toContain('https://ui.example.com/history');
	});

	it('says nothing at the first start, then "updated" or "rolled back"', async () => {
		make({ version: '1.1.0' }).checkVersion();
		expect(fake.messages).toHaveLength(0);
		n = make({ version: '1.2.0' });
		n.checkVersion();
		await n.idle();
		n = make({ version: '1.2.0' });
		n.checkVersion();
		await n.idle();
		n = make({ version: '1.1.3' });
		n.checkVersion();
		await n.idle();
		expect(texts()).toEqual([
			expect.stringContaining('Caddy UI updated to 1.2.0'),
			expect.stringContaining('Caddy UI rolled back to 1.1.3')
		]);
		expect(texts()[0]).toContain('It was 1.1.0 before.');
	});

	it('skips development and CI builds', async () => {
		make({ version: 'dev' }).checkVersion();
		make({ version: 'ci-abc' }).checkVersion();
		expect(db.prepare(`SELECT value FROM settings WHERE key = ?`).get(K.lastVersion)).toBeUndefined();
		expect(compareVersions('v1.10.0', '1.9.9')).toBeGreaterThan(0);
		expect(compareVersions('edge', '1.0.0')).toBeNull();
	});
});

describe('every event reaches the webhook', () => {
	it('sends a test of each one, marked as a test', async () => {
		const events: EventKind[] = [
			'site_down',
			'site_up',
			'upstream_down',
			'upstream_up',
			'cert_expiring',
			'caddyfile_external',
			'update_applied',
			'update_rolled_back'
		];
		for (const event of events) {
			const r = await n.test({ event });
			expect(r, event).toMatchObject({ ok: true, format: 'components', fellBack: false });
		}
		expect(fake.messages).toHaveLength(events.length);
		for (const t of texts()) expect(t).toContain('-# Test message with sample values');
		expect(n.view().deliveries.filter((d) => d.test)).toHaveLength(events.length);
	});

	it('falls back to an embed when the webhook refuses Components v2, and remembers it', async () => {
		fake.refuseComponents = true;
		const r = await n.test({ event: 'site_down' });
		expect(r).toMatchObject({ ok: true, format: 'embed', fellBack: true });
		expect(fake.messages[0]?.body.embeds).toBeDefined();
		expect(n.view().webhook.embedSince).toBe(now);
		// The next message goes as an embed at once.
		fake.reset();
		await n.test({ event: 'site_up' });
		expect(fake.messages[0]?.query).toEqual({ wait: 'true' });
		// "Try Components v2 again" forgets it.
		n.update({ retryComponents: true }, 'david');
		expect(n.view().webhook.embedSince).toBeNull();
	});

	it('tests an unsaved template and an unsaved webhook', async () => {
		const other = 'https://discord.com/api/webhooks/999999999999999999/another-fake-token-0123456789';
		const template = { ...defaultTemplate('site_down'), heading: 'Draft {site}' };
		await n.test({ event: 'site_down', template, webhook: other });
		expect(fake.messages[0]?.webhookId).toBe('999999999999999999');
		expect(texts()[0]).toContain('### Draft app.example.com');
	});

	it('refuses a test without a webhook, or with a template that does not pass its checks', async () => {
		n.update({ webhook: null }, 'david');
		await expect(n.test({ event: 'site_down' })).rejects.toMatchObject({ status: 409 });
		await expect(
			n.test({
				event: 'site_down',
				webhook: WEBHOOK,
				template: { ...defaultTemplate('site_down'), accent: 'red' }
			})
		).rejects.toBeInstanceOf(NotifyRefused);
	});
});

describe('settings', () => {
	it('never shows the webhook URL, only its id, and logs changes without it', () => {
		const v = n.view();
		expect(v.webhook).toEqual({ set: true, id: '123456789012345678', embedSince: null });
		expect(JSON.stringify(v)).not.toContain('fake-token');
		const log = db.prepare(`SELECT key, old_value, new_value FROM settings_log`).all();
		expect(log).toEqual([
			{ key: 'notify.webhook', old_value: null, new_value: 'webhook 123456789012345678' }
		]);
		expect(JSON.stringify(log)).not.toContain('fake-token');
	});

	it('stores only what differs from the default, and reset brings the default back', () => {
		const edited = { ...defaultTemplate('site_up'), heading: 'Up: {site}' };
		const v = n.update({ events: { site_up: edited }, flapMinutes: 10 }, 'david');
		expect(v.customized).toEqual(['site_up']);
		expect(
			JSON.parse(db.prepare(`SELECT value FROM settings WHERE key = ?`).pluck().get(K.config) as string)
		).toEqual({
			version: 1,
			flapMinutes: 10,
			events: { site_up: edited }
		});
		const back = n.update({ events: { site_up: null }, flapMinutes: 5 }, 'david');
		expect(back.customized).toEqual([]);
		expect(db.prepare(`SELECT value FROM settings WHERE key = ?`).get(K.config)).toBeUndefined();
	});

	it('checks everything before saving anything', () => {
		const bad = () =>
			n.update(
				{
					webhook: 'https://example.com/hook',
					downCycles: 0,
					events: { site_down: { ...defaultTemplate('site_down'), advanced: true, raw: '[{"type": 3}]' } }
				},
				'david'
			);
		expect(bad).toThrow(NotifyRefused);
		try {
			bad();
		} catch (err) {
			expect((err as NotifyRefused).body.errors).toEqual({
				webhook: expect.stringContaining('not a Discord webhook URL'),
				downCycles: 'A whole number from 1 to 20.',
				'events.site_down.raw': expect.stringContaining('Type 3')
			});
		}
		expect(n.config.downCycles).toBe(2);
		expect(n.view().webhook.id).toBe('123456789012345678');
	});
});
