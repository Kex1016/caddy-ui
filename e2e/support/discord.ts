// Helpers for the notifications spec: arrange and inspect the fake Discord (support/discord-fake.mjs).
import { DISCORD_URL } from './paths.mjs';

export type FakeMessage = {
	at: number;
	webhookId: string;
	token: string;
	query: Record<string, string>;
	body: Record<string, unknown>;
};

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${DISCORD_URL}${path}`, {
		method,
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`fake Discord ${method} ${path}: ${res.status} ${text}`);
	return JSON.parse(text) as T;
}

export const discord = {
	reset: () => call('POST', '/__fake/reset'),
	messages: () => call<FakeMessage[]>('GET', '/__fake/messages'),
	refuseComponents: (on: boolean) => call('POST', '/__fake/refuse-components', { on }),
	respondNext: (status: number, body: unknown = {}, times = 1) =>
		call('POST', '/__fake/respond-next', { status, body, times })
};

/** Every piece of text in a message (text displays, embed titles and descriptions), joined. */
export function textOf(m: FakeMessage): string {
	const parts: string[] = [];
	const walk = (x: unknown) => {
		if (Array.isArray(x)) x.forEach(walk);
		else if (x && typeof x === 'object') {
			const o = x as Record<string, unknown>;
			for (const k of ['content', 'title', 'description', 'label'] as const) {
				if (typeof o[k] === 'string') parts.push(o[k] as string);
			}
			Object.values(o).forEach(walk);
		}
	};
	walk(m.body.components ?? m.body.embeds);
	return parts.join(' | ');
}

/**
 * A made-up webhook URL in Discord's format; the UI sends it to the fake. Not a real webhook: the id and token
 * are invented, and CADDY_UI_DISCORD_API_URL points the UI at the fake.
 */
export const FAKE_WEBHOOK =
	'https://discord.com/api/webhooks/111111111111111111/e2e-fake-token-not-a-real-webhook-000000';
