import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DiscordSender, parseWebhookUrl, WebhookUrlError } from './discord';
import { startFakeDiscord, type FakeDiscord } from './fake-discord';

// Not a real webhook: the id and token are made up, and every request goes to the local fake.
const HOOK = { id: '123456789012345678', token: 'fake-token-not-a-real-one-0123456789' };
const v2 = () => ({
	flags: 1 << 15,
	components: [{ type: 10, content: 'hi' }],
	allowed_mentions: { parse: [] }
});
const embed = () => ({ embeds: [{ title: 'hi', color: 1 }], allowed_mentions: { parse: [] } });
const build = (f: 'components' | 'embed') => (f === 'components' ? v2() : embed());

let fake: FakeDiscord;
const slept: number[] = [];
const sender = () =>
	new DiscordSender({
		apiBase: fake.url,
		sleep: async (ms) => {
			slept.push(ms);
		}
	});

beforeAll(async () => {
	fake = await startFakeDiscord();
});
afterAll(() => fake.close());
beforeEach(() => {
	fake.reset();
	slept.length = 0;
});

describe('parseWebhookUrl', () => {
	it('reads the URL Discord gives, with or without an API version', () => {
		expect(parseWebhookUrl(`https://discord.com/api/webhooks/${HOOK.id}/${HOOK.token}`)).toEqual(HOOK);
		expect(parseWebhookUrl(` https://discordapp.com/api/v10/webhooks/${HOOK.id}/${HOOK.token}/ `)).toEqual(
			HOOK
		);
		expect(parseWebhookUrl(`https://canary.discord.com/api/webhooks/${HOOK.id}/${HOOK.token}`)).toEqual(HOOK);
	});

	it('refuses anything else, so the UI cannot be pointed at another host', () => {
		for (const bad of [
			'nope',
			`http://discord.com/api/webhooks/${HOOK.id}/${HOOK.token}`,
			`https://evil.example.com/api/webhooks/${HOOK.id}/${HOOK.token}`,
			`https://discord.com/api/webhooks/${HOOK.id}`,
			`https://discord.com/channels/1/2`
		]) {
			expect(() => parseWebhookUrl(bad), bad).toThrow(WebhookUrlError);
		}
	});
});

describe('DiscordSender', () => {
	it('sends Components v2 with ?with_components=true and waits for the message', async () => {
		const r = await sender().send(HOOK, build);
		expect(r).toEqual({
			ok: true,
			status: 200,
			format: 'components',
			attempts: 1,
			error: null,
			fellBack: false
		});
		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]?.query).toEqual({ wait: 'true', with_components: 'true' });
		expect(fake.messages[0]?.body.flags).toBe(1 << 15);
	});

	it('falls back to an embed when the webhook refuses Components v2', async () => {
		fake.refuseComponents = true;
		const r = await sender().send(HOOK, build);
		expect(r).toMatchObject({ ok: true, format: 'embed', fellBack: true, attempts: 2 });
		expect(fake.messages).toHaveLength(1);
		expect(fake.messages[0]?.body).toHaveProperty('embeds');
		expect(fake.messages[0]?.query).toEqual({ wait: 'true' });
	});

	it('sends an embed straight away for a webhook known to refuse v2', async () => {
		const r = await sender().send(HOOK, build, true);
		expect(r).toMatchObject({ ok: true, format: 'embed', fellBack: false, attempts: 1 });
	});

	it('waits as long as a 429 asks and tries again', async () => {
		fake.respondNext({
			status: 429,
			body: { message: 'You are being rate limited.', retry_after: 1.5, global: false }
		});
		const r = await sender().send(HOOK, build);
		expect(r).toMatchObject({ ok: true, attempts: 2 });
		expect(slept).toEqual([1500]);
	});

	it('drops a message when the rate limit asks for more than a minute', async () => {
		fake.respondNext({ status: 429, body: { retry_after: 600 } });
		const r = await sender().send(HOOK, build);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/wait 600s/);
	});

	it('retries 5xx answers with a growing pause, then gives up', async () => {
		fake.respondNext({ status: 502, body: { message: 'Bad Gateway' } }, 2);
		expect(await sender().send(HOOK, build)).toMatchObject({ ok: true, attempts: 3 });
		expect(slept).toEqual([1000, 3000]);

		slept.length = 0;
		fake.respondNext({ status: 500, body: {} }, 9);
		const r = await sender().send(HOOK, build);
		expect(r).toMatchObject({ ok: false, status: 500, attempts: 4 });
		expect(slept).toEqual([1000, 3000, 9000]);
	});

	it('gives up at once on a deleted webhook and says what to do, without the URL', async () => {
		fake.respondNext({ status: 404, body: { message: 'Unknown Webhook', code: 10015 } });
		const r = await sender().send(HOOK, build);
		expect(r).toMatchObject({ ok: false, status: 404, attempts: 1 });
		expect(r.error).toMatch(/Unknown Webhook \(code 10015\).*paste a new one/);
		expect(r.error).not.toContain(HOOK.token);
	});

	it('reports a network error after its retries', async () => {
		const s = new DiscordSender({
			apiBase: 'http://127.0.0.1:1/api/v10',
			sleep: async (ms) => void slept.push(ms)
		});
		const r = await s.send(HOOK, build);
		expect(r).toMatchObject({ ok: false, status: null, attempts: 4 });
		expect(r.error).toMatch(/could not be reached/);
	});

	it('waits for an empty rate-limit bucket before the next message', async () => {
		fake.respondNext({
			status: 200,
			body: { id: '1' },
			headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' }
		});
		const s = sender();
		await s.send(HOOK, build);
		await s.send(HOOK, build);
		expect(slept).toHaveLength(1);
		expect(slept[0]).toBeGreaterThan(1500);
	});

	it('sends one message at a time, in order', async () => {
		const s = sender();
		const seen: number[] = [];
		await Promise.all(
			[1, 2, 3].map((n) =>
				s
					.send(HOOK, () => ({ ...v2(), components: [{ type: 10, content: String(n) }] }))
					.then(() => seen.push(n))
			)
		);
		expect(seen).toEqual([1, 2, 3]);
		expect(fake.messages.map((m) => (m.body.components as { content: string }[])[0]?.content)).toEqual([
			'1',
			'2',
			'3'
		]);
	});
});
