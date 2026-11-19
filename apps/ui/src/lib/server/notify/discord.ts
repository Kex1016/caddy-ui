import type { DeliveryFormat } from '$lib/notify/types';

/**
 * Posting to a Discord webhook (docs/settings-and-perf-plan.md §3.1, "Delivery"): Components v2 first, a classic
 * embed when the webhook refuses that, a short retry for network errors and 5xx answers, and Discord's rate-limit
 * headers respected. Nothing here logs or returns the webhook URL; its token is a secret.
 *
 * The sender is the only Discord-specific part of the notifier; another target (ntfy, a generic JSON webhook)
 * would be a second sender with the same `send` shape (D21).
 */

/** Hosts a Discord webhook URL may name. Only these are accepted, so the UI cannot be pointed at internal hosts. */
const HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);

export type WebhookRef = { id: string; token: string };

export class WebhookUrlError extends Error {}

/**
 * Read a webhook URL as Discord shows it (Channel settings, Integrations, Webhooks, Copy Webhook URL):
 * `https://discord.com/api/webhooks/<id>/<token>`. Throws WebhookUrlError with a message for the form.
 */
export function parseWebhookUrl(raw: string): WebhookRef {
	const text = raw.trim();
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		throw new WebhookUrlError('Paste the whole webhook URL, starting with https://discord.com/api/webhooks/');
	}
	if (u.protocol !== 'https:' || !HOSTS.has(u.hostname.toLowerCase())) {
		throw new WebhookUrlError(
			'This is not a Discord webhook URL: it must start with https://discord.com/api/webhooks/'
		);
	}
	const m = /^\/api(?:\/v\d+)?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{20,200})\/?$/.exec(u.pathname);
	if (!m) {
		throw new WebhookUrlError(
			'The URL must look like https://discord.com/api/webhooks/<number>/<token>; copy it again from Discord'
		);
	}
	return { id: m[1] as string, token: m[2] as string };
}

export type SendResult = {
	ok: boolean;
	status: number | null;
	format: DeliveryFormat;
	attempts: number;
	error: string | null;
	/** The webhook refused Components v2 and the embed was sent instead. */
	fellBack: boolean;
};

export type SenderOptions = {
	/** Discord's API base, `https://discord.com/api/v10`. Tests point it at a fake (`CADDY_UI_DISCORD_API_URL`). */
	apiBase: string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	timeoutMs?: number;
};

/** Waits between tries after a network error or a 5xx: three tries after the first, about 13 s in all. */
const BACKOFF_MS = [1_000, 3_000, 9_000];
/** A rate limit asking for a longer wait than this is given up on; the next event tries again. */
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_ATTEMPTS = 5;

type DiscordError = { message?: string; code?: number; retry_after?: number };

function describe(status: number, body: DiscordError | null): string {
	if (body?.message)
		return `Discord answered ${status}: ${body.message}${body.code ? ` (code ${body.code})` : ''}`;
	return `Discord answered HTTP ${status}`;
}

/** What to say when the webhook is gone or the token is wrong; the URL is never part of it. */
function goneText(status: number, body: DiscordError | null): string {
	if (status === 404 || status === 401) {
		return `${describe(status, body)}. The webhook was deleted or its URL is wrong; paste a new one in Settings.`;
	}
	return describe(status, body);
}

/**
 * One sender per process. Sends go one at a time, so a burst of events (ten sites down at once) is spaced by
 * Discord's own rate-limit answers instead of being refused.
 */
export class DiscordSender {
	readonly #apiBase: string;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	#queue: Promise<unknown> = Promise.resolve();
	/** When the webhook's bucket is empty (X-RateLimit-Remaining: 0), the time it refills. */
	#blockedUntil = 0;

	constructor(opts: SenderOptions) {
		this.#apiBase = opts.apiBase.replace(/\/+$/, '');
		this.#fetch = opts.fetch ?? ((...a) => fetch(...a));
		this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.#now = opts.now ?? Date.now;
		this.#timeoutMs = opts.timeoutMs ?? 10_000;
	}

	/** Messages waiting or being sent. */
	pending = 0;

	/**
	 * Send one message. `build` makes the payload for a format; `preferEmbed` skips Components v2 for a webhook
	 * that refused it before. Never throws: the result says what happened.
	 */
	send(
		webhook: WebhookRef,
		build: (format: DeliveryFormat) => unknown,
		preferEmbed = false
	): Promise<SendResult> {
		this.pending++;
		const run = this.#queue.then(() => this.#send(webhook, build, preferEmbed));
		this.#queue = run.catch(() => undefined);
		return run.finally(() => this.pending--);
	}

	async #send(
		webhook: WebhookRef,
		build: (format: DeliveryFormat) => unknown,
		preferEmbed: boolean
	): Promise<SendResult> {
		let format: DeliveryFormat = preferEmbed ? 'embed' : 'components';
		let fellBack = false;
		let backoff = 0;
		let last: { status: number | null; error: string } = { status: null, error: 'not sent' };
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const wait = this.#blockedUntil - this.#now();
			if (wait > 0) await this.#sleep(Math.min(wait, MAX_RETRY_AFTER_MS));
			const done = (ok: boolean, status: number | null, error: string | null): SendResult => ({
				ok,
				status,
				format,
				attempts: attempt,
				error,
				fellBack
			});

			const query = format === 'components' ? '?wait=true&with_components=true' : '?wait=true';
			let res: Response;
			try {
				res = await this.#fetch(`${this.#apiBase}/webhooks/${webhook.id}/${webhook.token}${query}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'user-agent': 'caddy-ui (notifications)' },
					body: JSON.stringify(build(format)),
					signal: AbortSignal.timeout(this.#timeoutMs)
				});
			} catch (err) {
				const why =
					err instanceof Error
						? err.name === 'TimeoutError'
							? 'no answer within 10s'
							: err.message
						: String(err);
				last = { status: null, error: `Discord could not be reached: ${why}` };
				const delay = BACKOFF_MS[backoff++];
				if (delay === undefined) return done(false, null, last.error);
				await this.#sleep(delay);
				continue;
			}

			this.#noteBucket(res.headers);
			const body = res.ok ? null : ((await res.json().catch(() => null)) as DiscordError | null);
			if (res.ok) {
				await res.body?.cancel().catch(() => undefined);
				return done(true, res.status, null);
			}
			last = { status: res.status, error: describe(res.status, body) };

			if (res.status === 429) {
				const seconds = Number(body?.retry_after ?? res.headers.get('retry-after') ?? 1);
				const ms = Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000);
				if (ms > MAX_RETRY_AFTER_MS) {
					return done(
						false,
						429,
						`Discord asked to wait ${Math.round(ms / 1000)}s; this message was dropped`
					);
				}
				await this.#sleep(ms);
				continue;
			}
			if (res.status === 400 && format === 'components') {
				// A webhook that will not take Components v2 (plan §3.1): send the same message as an embed.
				format = 'embed';
				fellBack = true;
				continue;
			}
			if (res.status >= 500) {
				const delay = BACKOFF_MS[backoff++];
				if (delay === undefined) return done(false, res.status, last.error);
				await this.#sleep(delay);
				continue;
			}
			return done(false, res.status, goneText(res.status, body));
		}
		return {
			ok: false,
			status: last.status,
			format,
			attempts: MAX_ATTEMPTS,
			error: last.error,
			fellBack
		};
	}

	#noteBucket(h: Headers): void {
		if (h.get('x-ratelimit-remaining') !== '0') return;
		const after = Number(h.get('x-ratelimit-reset-after'));
		if (Number.isFinite(after) && after > 0) this.#blockedUntil = this.#now() + Math.ceil(after * 1000);
	}
}
