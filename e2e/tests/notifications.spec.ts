import net from 'node:net';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { discord, FAKE_WEBHOOK, textOf, type FakeMessage } from '../support/discord';
import { applyViaApi, e2eCaddyfile, expectAccessible, putOnDisk, watchConsole } from '../support/helpers';

// Discord notifications (docs/settings-and-perf-plan.md §3.1, S5). Every message goes to the fake Discord that
// support/stack.mjs starts (CADDY_UI_DISCORD_API_URL); FAKE_WEBHOOK is made up. The stack probes every 5 s.

const EVENTS = [
	'site_down',
	'site_up',
	'upstream_down',
	'upstream_up',
	'cert_expiring',
	'caddyfile_external',
	'update_applied',
	'update_rolled_back'
];

/** Every spec shares one stack, so nothing saved here may outlive this file. */
async function resetAll(request: APIRequestContext) {
	const res = await request.put('/api/notifications', {
		data: {
			webhook: null,
			downCycles: 2,
			flapMinutes: 5,
			retryComponents: true,
			events: Object.fromEntries(EVENTS.map((k) => [k, null]))
		}
	});
	expect(res.ok(), await res.text()).toBe(true);
	await discord.reset();
}

const section = (page: Page) =>
	page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Notifications' }) });

const eventRow = (page: Page, label: string) =>
	section(page)
		.getByRole('listitem')
		.filter({ has: page.getByRole('switch', { name: label, exact: true }) });

async function saveWebhook(request: APIRequestContext) {
	const res = await request.put('/api/notifications', { data: { webhook: FAKE_WEBHOOK } });
	expect(res.ok(), await res.text()).toBe(true);
}

async function waitForMessage(match: (m: FakeMessage) => boolean, what: string): Promise<FakeMessage> {
	let found: FakeMessage | undefined;
	await expect
		.poll(async () => (found = (await discord.messages()).find(match)) !== undefined, {
			message: `the fake Discord never got ${what}`,
			timeout: 45_000,
			intervals: [500, 1000, 2000]
		})
		.toBe(true);
	return found as FakeMessage;
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => resetAll(request));
test.afterAll(async ({ request }) => resetAll(request));

test('the webhook URL is write-only: saved, then never shown or sent back', async ({ page }) => {
	await page.goto('/settings#notifications');
	const s = section(page);
	await expect(s.getByText('Not set', { exact: true })).toBeVisible();

	await s.getByLabel('Discord webhook').fill('https://example.com/not-a-webhook');
	await s.getByRole('button', { name: 'Save webhook' }).click();
	await expect(s.getByText(/not a Discord webhook URL/)).toBeVisible();
	// The refused save above logs its 400 in the console; from here on nothing may.
	const clean = watchConsole(page);

	await s.getByLabel('Discord webhook').fill(FAKE_WEBHOOK);
	await s.getByRole('button', { name: 'Save webhook' }).click();
	await expect(s.getByText('Saved. It is not shown again.')).toBeVisible();
	await expect(s.getByText('Saved · webhook …1111')).toBeVisible();
	await expect(s.getByLabel('Discord webhook')).toHaveValue('');

	const token = FAKE_WEBHOOK.split('/').pop() as string;
	expect(await page.content()).not.toContain(token);
	expect(await (await page.request.get('/api/notifications')).text()).not.toContain(token);
	expect(await (await page.request.get('/api/settings')).text()).not.toContain(token);
	await page.reload();
	expect(await page.content()).not.toContain(token);

	// The change is in Recent changes, by id only.
	const changes = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { level: 2, name: 'Recent changes' }) });
	await expect(changes.getByRole('row').filter({ hasText: 'Discord webhook' })).toContainText(
		'nothing saved → webhook 111111111111111111'
	);
	clean();
});

test('a message is edited with a live preview, sent as a test, saved and reset', async ({ page }) => {
	const clean = watchConsole(page);
	await page.goto('/settings#notifications');
	const row = eventRow(page, 'Site down');
	await row.getByRole('button', { name: 'Edit message' }).click();

	const preview = row.getByLabel('Preview of the Discord message');
	await expect(preview).toContainText('app.example.com is down');
	await row.getByLabel('Heading').fill('Alarm: ');
	await row.getByRole('button', { name: '{site}' }).click();
	await expect(row.getByLabel('Heading')).toHaveValue('Alarm: {site}');
	await expect(preview).toContainText('Alarm: app.example.com');
	await expect(row.getByText('Not saved yet.')).toBeVisible();

	await expectAccessible(page, 'Settings with the message editor open');

	await row.getByRole('button', { name: 'Send test' }).click();
	await expect(row.getByText('Check the channel. It is marked as a test.')).toBeVisible();
	const sent = await waitForMessage((m) => textOf(m).includes('Alarm: app.example.com'), 'the test message');
	expect(sent.webhookId).toBe('111111111111111111');
	expect(sent.query).toEqual({ wait: 'true', with_components: 'true' });
	expect(sent.body.flags).toBe(1 << 15);
	expect(textOf(sent)).toContain('Test message with sample values');

	await row.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(row.getByText('Saved.', { exact: true })).toBeVisible();
	await expect(row.getByText('Edited', { exact: true })).toBeVisible();

	await row.getByRole('button', { name: 'Reset to default' }).click();
	await expect(row.getByLabel('Heading')).toHaveValue('{site} is down');
	await row.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(row.getByText('Edited', { exact: true })).toHaveCount(0);

	const sentRows = page
		.locator('section#notifications table')
		.getByRole('row')
		.filter({ hasText: 'Site down (test)' });
	await expect(sentRows.first()).toContainText('Sent');
	clean();
});

test('the raw Components v2 JSON sits behind the advanced switch and is checked', async ({ page }) => {
	await page.goto('/settings#notifications');
	const row = eventRow(page, 'Update applied');
	await row.getByRole('button', { name: 'Edit message' }).click();
	// The switch's input is visually hidden behind its track; a person clicks the label.
	await row.getByText('Edit the raw JSON', { exact: true }).click();
	await expect(row.getByRole('switch', { name: 'Edit the raw JSON' })).toBeChecked();
	const raw = row.getByLabel('Components v2 JSON');
	await expect(raw).toHaveValue(/"type": 17/);
	await expect(raw).toHaveValue(/Caddy UI updated to \{version\}/);

	await raw.fill(
		'[{"type": 1, "components": [{"type": 2, "style": 1, "custom_id": "x", "label": "Restart"}]}]'
	);
	await expect(row.getByText(/Only link buttons \(style 5\)/).first()).toBeVisible();
	await expect(row.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

	await raw.fill(
		'[{"type": 17, "accent_color": 255, "components": [{"type": 10, "content": "## Now on {version}"}]}]'
	);
	await expect(row.getByLabel('Preview of the Discord message')).toContainText('Now on 1.2.0');
	await row.getByText('Edit the raw JSON', { exact: true }).click();
	await expect(row.getByLabel('Heading')).toHaveValue('Caddy UI updated to {version}');
});

test('every event reaches the webhook as a test', async ({ request }) => {
	await discord.reset();
	for (const event of EVENTS) {
		const res = await request.post('/api/notifications/test', { data: { event } });
		expect(res.ok(), `${event}: ${await res.text()}`).toBe(true);
		expect(await res.json()).toMatchObject({ ok: true, format: 'components' });
	}
	const tests = (await discord.messages()).filter((m) =>
		textOf(m).includes('Test message with sample values')
	);
	expect(tests).toHaveLength(EVENTS.length);
	expect(tests.map((m) => textOf(m).split(' | ')[0])).toEqual([
		'### app.example.com is down',
		'### app.example.com is back up',
		'### Upstream 10.0.0.5:8080 is down',
		'### Upstream 10.0.0.5:8080 is back up',
		'### Certificate for app.example.com expires in 9 days',
		'### Caddyfile changed outside the UI',
		'### Caddy UI updated to 1.2.0',
		'### Caddy UI rolled back to 1.1.0'
	]);
});

test('a webhook that refuses Components v2 gets the same message as an embed', async ({ page }) => {
	await discord.reset();
	await discord.refuseComponents(true);
	try {
		await page.goto('/settings#notifications');
		const row = eventRow(page, 'Site back up');
		await row.getByRole('button', { name: 'Edit message' }).click();
		await row.getByRole('button', { name: 'Send test' }).click();
		await expect(row.getByText('The webhook refused Components v2, so it went as an embed.')).toBeVisible();
		const [m] = await discord.messages();
		expect(m?.query).toEqual({ wait: 'true' });
		expect(m?.body.embeds).toEqual([
			expect.objectContaining({ title: 'app.example.com is back up', color: 0x30a46c })
		]);
		const notice = section(page).getByText(/This webhook refused a Components v2 message/);
		await expect(notice).toBeVisible();
		// The preview now shows the embed this webhook gets.
		await expect(row.getByText('Shown as the embed this webhook gets.')).toBeVisible();
		await section(page).getByRole('button', { name: 'Try Components v2 again' }).click();
		await expect(notice).toHaveCount(0);
	} finally {
		await discord.refuseComponents(false);
	}
});

test('an upstream going down and back up is announced, and so is an edit outside the UI', async ({
	request
}) => {
	// A local upstream the UI probes directly (a loopback upstream is probed on Caddy's host, 127.0.0.1 here).
	test.setTimeout(150_000);
	const sockets = new Set<net.Socket>();
	const upstream = net.createServer((sock) => {
		sockets.add(sock);
		sock.on('close', () => sockets.delete(sock));
		sock.on('error', () => undefined);
		sock.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
	});
	// Caddy may keep a proxied connection open; closing drops them all, so the port is free at once.
	const stop = () =>
		new Promise<void>((r) => {
			upstream.close(() => r());
			for (const s of sockets) s.destroy();
		});
	await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
	const port = (upstream.address() as net.AddressInfo).port;
	const address = `127.0.0.1:${port}`;
	const site = `http://notify-e2e.example.com:18080 {\n\treverse_proxy ${address}\n}\n`;
	try {
		await saveWebhook(request);
		const res = await request.put('/api/notifications', {
			data: {
				downCycles: 1,
				flapMinutes: 0,
				events: {
					// Only the upstream events: whether the site itself answers depends on how Caddy runs (CI runs it in
					// Docker, where port 18080 is not published), so its events are left out here.
					site_down: { ...(await defaults(request)).site_down, enabled: false },
					site_up: { ...(await defaults(request)).site_up, enabled: false },
					upstream_down: { ...(await defaults(request)).upstream_down, enabled: true },
					upstream_up: { ...(await defaults(request)).upstream_up, enabled: true }
				}
			}
		});
		expect(res.ok(), await res.text()).toBe(true);
		await discord.reset();
		const applied = await applyViaApi(request, `${e2eCaddyfile()}\n${site}`);

		// Up first: no message. Then stop it.
		await new Promise((r) => setTimeout(r, 6_000));
		expect((await discord.messages()).filter((m) => textOf(m).includes(address))).toEqual([]);
		await stop();
		const down = await waitForMessage(
			(m) => textOf(m).includes(`Upstream ${address} is down`),
			'upstream down'
		);
		expect(textOf(down)).toContain('Used by http://notify-e2e.example.com:18080.');

		await new Promise<void>((r) => upstream.listen(port, '127.0.0.1', () => r()));
		const up = await waitForMessage(
			(m) => textOf(m).includes(`Upstream ${address} is back up`),
			'upstream up'
		);
		expect(textOf(up)).toMatch(/Down for (under a minute|\dm)/);

		// An edit on disk, made without the UI.
		await putOnDisk(request, `${applied.text}\n# edited by hand in the notifications spec\n`);
		const edit = await waitForMessage(
			(m) => textOf(m).includes('Caddyfile changed outside the UI'),
			'the outside edit'
		);
		expect(textOf(edit)).toMatch(/revision #\d+ in History/);
	} finally {
		if (upstream.listening) await stop();
		await applyViaApi(request, e2eCaddyfile());
	}
});

async function defaults(request: APIRequestContext) {
	const view = await (await request.get('/api/notifications')).json();
	return view.config.events as Record<string, Record<string, unknown>>;
}
