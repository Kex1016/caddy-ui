/**
 * Discord notifications (docs/settings-and-perf-plan.md §3.1): the shapes shared by the server, the API and the
 * Settings page. Client-safe: no Node imports. The webhook URL never appears in any of these; the view only says
 * whether one is saved.
 */

/** Every event that can send a message, in the order the Settings page lists them. */
export const EVENTS = [
	'site_down',
	'site_up',
	'upstream_down',
	'upstream_up',
	'cert_expiring',
	'caddyfile_external',
	'update_applied',
	'update_rolled_back'
] as const;

export type EventKind = (typeof EVENTS)[number];

export const isEventKind = (v: unknown): v is EventKind =>
	typeof v === 'string' && (EVENTS as readonly string[]).includes(v);

/**
 * One event's message. In field mode the message is built from `heading`, `body`, `accent`, `mention` and
 * `button`; with `advanced` on, `raw` (a JSON array of Components v2 components, with the same placeholders)
 * is sent instead, and the fields are kept for when the switch is turned off again.
 */
export type EventTemplate = {
	enabled: boolean;
	heading: string;
	body: string;
	/** `#rrggbb`: the container's accent colour (the embed's colour in the fallback). */
	accent: string;
	/** Who to ping: empty, `<@&role id>`, `<@user id>`, `@here` or `@everyone`. Nobody else is ever pinged. */
	mention: string;
	/** Add a link button to the page in this UI. Needs a public address (`CADDY_UI_PUBLIC_URL`). */
	button: boolean;
	advanced: boolean;
	/** The raw components JSON, or null when it was never edited (the default layout is shown then). */
	raw: string | null;
};

export type NotifyConfig = {
	/** Consecutive failed probe cycles before "down" is sent. */
	downCycles: number;
	/** At most one message per site or upstream within this many minutes; 0 turns the limit off. */
	flapMinutes: number;
	events: Record<EventKind, EventTemplate>;
};

/** How messages reach the webhook: Components v2, or a classic embed after the webhook refused v2. */
export type DeliveryFormat = 'components' | 'embed';

/** One message sent, or given up on, newest first in the view. The webhook URL is never stored here. */
export type Delivery = {
	id: number;
	ts: number;
	event: EventKind;
	/** What it was about: a site address, an upstream, a host, a revision, a version. */
	subject: string;
	ok: boolean;
	/** The last HTTP status from Discord; null when it could not be reached. */
	status: number | null;
	format: DeliveryFormat;
	attempts: number;
	error: string | null;
	test: boolean;
};

/** `GET /api/notifications`, and the answer to a successful `PUT`. */
export type NotifyView = {
	webhook: {
		set: boolean;
		/** The webhook's id (the number in its URL, not secret), so it can be told apart from another one. */
		id: string | null;
		/** Set when this webhook refused a Components v2 message and messages go as embeds. */
		embedSince: number | null;
	};
	config: NotifyConfig;
	/** Events whose message differs from the default. */
	customized: EventKind[];
	/** `CADDY_UI_PUBLIC_URL`, which link buttons need; null when unset. */
	publicUrl: string | null;
	timeZone: string;
	deliveries: Delivery[];
};

/**
 * `PUT /api/notifications`. Everything is optional. `webhook`: a string saves a new URL, null removes it, absent
 * keeps the saved one (it is never sent back). `events[kind]`: a template replaces it, null resets it to the
 * default.
 */
export type NotifyPatch = {
	webhook?: string | null;
	downCycles?: number;
	flapMinutes?: number;
	events?: Partial<Record<EventKind, EventTemplate | null>>;
	/** Forget that the webhook refused Components v2, and try them again with the next message. */
	retryComponents?: boolean;
};

/** `POST /api/notifications/test`: send one event with sample values. */
export type NotifyTestRequest = {
	event: EventKind;
	/** The template as typed, when it is not saved yet; else the saved one. */
	template?: EventTemplate;
	/** A webhook URL typed but not saved yet; else the saved one. */
	webhook?: string;
};

export type NotifyTestResult = {
	ok: boolean;
	format: DeliveryFormat;
	status: number | null;
	error: string | null;
	/** True when the webhook refused Components v2 and the embed fallback was sent instead. */
	fellBack: boolean;
};

export type NotifyError = {
	message: string;
	code: 'INVALID' | 'NO_WEBHOOK';
	errors?: Record<string, string>;
};
