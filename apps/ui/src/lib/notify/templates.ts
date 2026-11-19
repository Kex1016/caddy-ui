import { formatDateTime, formatElapsed } from '$lib/format';
import type { EventKind, EventTemplate, NotifyConfig } from './types';
import { EVENTS } from './types';

/**
 * Default messages, placeholders and the Discord payloads built from them (docs/settings-and-perf-plan.md §3.1).
 * Client-safe, so the Settings page's live preview and the server's sender build exactly the same message.
 *
 * Discord facts this relies on (checked against docs.discord.com on 19 Nov 2026, DECISIONS.md S5):
 * - Execute Webhook ignores `components` unless `?with_components=true`; a webhook that no app owns may then send
 *   non-interactive components. Link buttons are not interactive (they open a URL and send no event).
 * - `flags: 32768` (IS_COMPONENTS_V2) makes the message components-only: `content` and `embeds` are refused.
 * - At most 40 components per message; at most 5 buttons per action row. Mentions inside a Text Display ping only
 *   as `allowed_mentions` allows, which is why every payload sets it explicitly.
 */

export const COMPONENTS_V2_FLAG = 1 << 15;

/** Component type numbers (Discord's component reference). */
export const C = {
	ActionRow: 1,
	Button: 2,
	Section: 9,
	TextDisplay: 10,
	Thumbnail: 11,
	MediaGallery: 12,
	Separator: 14,
	Container: 17
} as const;

/** Button style 5 is a link button: a URL, no custom id, no interaction. */
export const LINK_STYLE = 5;

export const MAX_COMPONENTS = 40;
/** Text across all Text Displays. Discord documents 4000; kept here as the check before sending. */
export const MAX_TEXT = 4000;
const MAX_RAW_BYTES = 16 * 1024;

export const EVENT_LABELS: Record<EventKind, string> = {
	site_down: 'Site down',
	site_up: 'Site back up',
	upstream_down: 'Upstream down',
	upstream_up: 'Upstream back up',
	cert_expiring: 'Certificate expiring',
	caddyfile_external: 'Caddyfile changed outside the UI',
	update_applied: 'Update applied',
	update_rolled_back: 'Update rolled back'
};

export const EVENT_HINTS: Record<EventKind, string> = {
	site_down: 'After the set number of failed probe cycles in a row.',
	site_up: 'When a site that was reported down answers again.',
	upstream_down: 'Off by default: a down upstream usually takes its site down too, which is already sent.',
	upstream_up: 'When an upstream that was reported down answers again.',
	cert_expiring:
		'Once when a certificate enters the warning window (Settings → Monitoring, 14 days by default), and again with 3 days left.',
	caddyfile_external: 'When the Caddyfile changes on disk without this UI, also while it was stopped.',
	update_applied: 'At the first start of a newer version.',
	update_rolled_back: 'At the first start of an older version than last time.'
};

/** Accent colours: red down, green up, amber warning (plan §3.1). */
export const ACCENTS = { red: '#e5484d', green: '#30a46c', amber: '#f5a524' } as const;

/** Placeholders each event fills, besides the common `{time}` and `{url}`. */
export const PLACEHOLDERS: Record<EventKind, string[]> = {
	site_down: ['site', 'status', 'error', 'since'],
	site_up: ['site', 'status', 'since', 'duration'],
	upstream_down: ['upstream', 'site', 'error', 'since'],
	upstream_up: ['upstream', 'site', 'since', 'duration'],
	cert_expiring: ['site', 'days_left', 'expires_in', 'expires', 'issuer'],
	caddyfile_external: ['revision'],
	update_applied: ['version', 'previous_version'],
	update_rolled_back: ['version', 'previous_version']
};
export const COMMON_PLACEHOLDERS = ['time', 'url'];

export const PLACEHOLDER_HINTS: Record<string, string> = {
	site: 'The site’s address (for an upstream, the sites that use it)',
	status: 'What the probe got: HTTP 502, no answer…',
	error: 'The probe’s error',
	since: 'When it went down',
	duration: 'How long it was down',
	upstream: 'The upstream’s address',
	days_left: 'Whole days until the certificate expires',
	expires_in: '“9 days”, “1 day” or “under a day”',
	expires: 'When the certificate expires',
	issuer: 'Who issued the certificate',
	revision: 'The History revision the edit was saved as',
	version: 'The version now running',
	previous_version: 'The version that ran before',
	time: 'When this happened',
	url: 'The link to this in the UI (needs a public address)'
};

/** Values that are already Discord markup (timestamps) or a URL, so they are not escaped. */
const MARKUP_VARS = new Set(['since', 'time', 'expires', 'url']);

const BUTTON_LABELS: Record<EventKind, string> = {
	site_down: 'Open site',
	site_up: 'Open site',
	upstream_down: 'Open Sites',
	upstream_up: 'Open Sites',
	cert_expiring: 'Open site',
	caddyfile_external: 'Open History',
	update_applied: 'Open Caddy UI',
	update_rolled_back: 'Open Caddy UI'
};

const DEFAULTS: Record<EventKind, Omit<EventTemplate, 'advanced' | 'raw' | 'mention'>> = {
	site_down: {
		enabled: true,
		heading: '{site} is down',
		body: 'Failing since {since}.\n**Error:** {error}',
		accent: ACCENTS.red,
		button: true
	},
	site_up: {
		enabled: true,
		heading: '{site} is back up',
		body: 'Down for {duration}, since {since}. It answers again ({status}).',
		accent: ACCENTS.green,
		button: true
	},
	upstream_down: {
		enabled: false,
		heading: 'Upstream {upstream} is down',
		body: 'Used by {site}. Failing since {since}.\n**Error:** {error}',
		accent: ACCENTS.red,
		button: true
	},
	upstream_up: {
		enabled: false,
		heading: 'Upstream {upstream} is back up',
		body: 'Down for {duration}, since {since}. Used by {site}.',
		accent: ACCENTS.green,
		button: true
	},
	cert_expiring: {
		enabled: true,
		heading: 'Certificate for {site} expires in {expires_in}',
		body: 'It expires {expires} and was issued by {issuer}. Caddy renews certificates well before this, so renewal is probably failing: check Caddy’s log.',
		accent: ACCENTS.amber,
		button: true
	},
	caddyfile_external: {
		enabled: true,
		heading: 'Caddyfile changed outside the UI',
		body: 'The file on disk changed {time} without this UI. It is saved as revision {revision} in History, where it can be compared and undone.',
		accent: ACCENTS.amber,
		button: true
	},
	update_applied: {
		enabled: true,
		heading: 'Caddy UI updated to {version}',
		body: 'It was {previous_version} before. Running since {time}.',
		accent: ACCENTS.green,
		button: true
	},
	update_rolled_back: {
		enabled: true,
		heading: 'Caddy UI rolled back to {version}',
		body: 'It was {previous_version} before. The newer version was replaced, most likely because it did not start or failed its health check.',
		accent: ACCENTS.amber,
		button: true
	}
};

export function defaultTemplate(kind: EventKind): EventTemplate {
	return { ...DEFAULTS[kind], mention: '', advanced: false, raw: null };
}

export const DEFAULT_DOWN_CYCLES = 2;
export const DEFAULT_FLAP_MINUTES = 5;

export function defaultConfig(): NotifyConfig {
	return {
		downCycles: DEFAULT_DOWN_CYCLES,
		flapMinutes: DEFAULT_FLAP_MINUTES,
		events: Object.fromEntries(EVENTS.map((k) => [k, defaultTemplate(k)])) as Record<EventKind, EventTemplate>
	};
}

export function sameTemplate(a: EventTemplate, b: EventTemplate): boolean {
	return (
		a.enabled === b.enabled &&
		a.heading === b.heading &&
		a.body === b.body &&
		a.accent.toLowerCase() === b.accent.toLowerCase() &&
		a.mention === b.mention &&
		a.button === b.button &&
		a.advanced === b.advanced &&
		(a.raw ?? null) === (b.raw ?? null)
	);
}

// ── values ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The values for one message. `text` holds plain-text versions of the timestamp values, for places where
 * Discord does not render `<t:…>` (an embed's title) and for the UI's own preview.
 */
export type Vars = { values: Record<string, string>; text: Record<string, string> };

/** A Discord timestamp: every reader sees it in their own time zone. */
export const discordTime = (ts: number, style: 'f' | 'R' = 'f') => `<t:${Math.floor(ts / 1000)}:${style}>`;

/**
 * Build the values for an event. `at` maps the time values (`since`, `time`, `expires`) to epoch ms; they become
 * Discord timestamps, with plain text in `timeZone` beside them.
 */
export function makeVars(
	values: Record<string, string>,
	at: Partial<Record<'since' | 'time' | 'expires', number>>,
	timeZone: string
): Vars {
	const v: Record<string, string> = { ...values };
	const text: Record<string, string> = {};
	for (const [k, ts] of Object.entries(at)) {
		if (ts === undefined) continue;
		v[k] = discordTime(ts);
		text[k] = formatDateTime(ts, timeZone);
	}
	return { values: v, text };
}

export function expiresIn(ms: number): string {
	const days = Math.floor(ms / 86_400_000);
	if (days < 1) return 'under a day';
	return days === 1 ? '1 day' : `${days} days`;
}

/** The link to an event's page in the UI, or '' without a public address. */
export function uiLink(publicUrl: string | null | undefined, path: string): string {
	return publicUrl ? `${publicUrl.replace(/\/+$/, '')}${path}` : '';
}

/** Sample values for the preview and "Send test". */
export function sampleVars(
	kind: EventKind,
	opts: { now: number; publicUrl: string | null; timeZone: string }
) {
	const { now, publicUrl, timeZone } = opts;
	const min = 60_000;
	const link = (p: string) => uiLink(publicUrl, p);
	switch (kind) {
		case 'site_down':
			return makeVars(
				{ site: 'app.example.com', status: 'HTTP 502', error: 'HTTP 502', url: link('/sites/sample') },
				{ since: now - 2 * min, time: now },
				timeZone
			);
		case 'site_up':
			return makeVars(
				{ site: 'app.example.com', status: 'HTTP 200', duration: '14m', url: link('/sites/sample') },
				{ since: now - 14 * min, time: now },
				timeZone
			);
		case 'upstream_down':
			return makeVars(
				{
					upstream: '10.0.0.5:8080',
					site: 'app.example.com',
					error: 'ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:8080',
					url: link('/sites')
				},
				{ since: now - 2 * min, time: now },
				timeZone
			);
		case 'upstream_up':
			return makeVars(
				{ upstream: '10.0.0.5:8080', site: 'app.example.com', duration: '6m', url: link('/sites') },
				{ since: now - 6 * min, time: now },
				timeZone
			);
		case 'cert_expiring':
			return makeVars(
				{
					site: 'app.example.com',
					days_left: '9',
					expires_in: '9 days',
					issuer: 'Let’s Encrypt',
					url: link('/sites/sample')
				},
				{ expires: now + 9 * 86_400_000 + 3 * 3_600_000, time: now },
				timeZone
			);
		case 'caddyfile_external':
			return makeVars({ revision: '#128', url: link('/history') }, { time: now - min }, timeZone);
		case 'update_applied':
			return makeVars(
				{ version: '1.2.0', previous_version: '1.1.0', url: link('/') },
				{ time: now },
				timeZone
			);
		case 'update_rolled_back':
			return makeVars(
				{ version: '1.1.0', previous_version: '1.2.0', url: link('/') },
				{ time: now },
				timeZone
			);
	}
}

/** Escape Discord markdown in a value, so a site called `*.example.com` stays as written. */
export function escapeMarkdown(s: string): string {
	return s.replace(/([\\*_~|`>[\]])/g, '\\$1');
}

/**
 * Replace `{name}` with its value. Unknown names stay as typed, so a typo shows in the preview. `plain` uses the
 * plain-text time values (for an embed title, where Discord does not render timestamps).
 */
export function fill(text: string, vars: Vars, opts: { escape?: boolean; plain?: boolean } = {}): string {
	const escape = opts.escape ?? true;
	return text.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
		if (opts.plain && name in vars.text) return vars.text[name] as string;
		const v = vars.values[name];
		if (v === undefined) return whole;
		return escape && !MARKUP_VARS.has(name) ? escapeMarkdown(v) : v;
	});
}

// ── components ──────────────────────────────────────────────────────────────────────────────────

export type Component = { type: number; [key: string]: unknown };

const hexToInt = (hex: string) => {
	const n = Number.parseInt(hex.replace(/^#/, ''), 16);
	return Number.isFinite(n) ? n : 0;
};

export const intToHex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * The message built from the fields: a container with the accent colour, the heading, the body, a line with the
 * time, and a link button. Used for sending, for the preview, and (with placeholders left in) as the starting
 * point of the raw JSON editor.
 */
export function fieldComponents(kind: EventKind, t: EventTemplate, vars: Vars | null): Component[] {
	const f = (s: string) => (vars ? fill(s, vars) : s);
	const inner: Component[] = [];
	const heading = f(t.heading).trim();
	const body = f(t.body).trim();
	if (heading) inner.push({ type: C.TextDisplay, content: `### ${heading}` });
	if (body) inner.push({ type: C.TextDisplay, content: body });
	inner.push({ type: C.TextDisplay, content: `-# Caddy UI · ${vars ? vars.values.time : '{time}'}` });
	const url = vars ? (vars.values.url ?? '') : '{url}';
	if (t.button && url) {
		inner.push({
			type: C.ActionRow,
			components: [{ type: C.Button, style: LINK_STYLE, label: BUTTON_LABELS[kind], url }]
		});
	}
	return [{ type: C.Container, accent_color: hexToInt(t.accent), components: inner }];
}

/** The starting text of the raw editor: the field layout with placeholders, as indented JSON. */
export function defaultRaw(kind: EventKind, t: EventTemplate): string {
	return JSON.stringify(fieldComponents(kind, t, null), null, 2);
}

/** Put values into every string of a raw components tree. Text is escaped; URLs are not. */
function fillTree(node: unknown, vars: Vars, key = ''): unknown {
	if (typeof node === 'string') return fill(node, vars, { escape: key === 'content' });
	if (Array.isArray(node)) return node.map((n) => fillTree(n, vars, key));
	if (node && typeof node === 'object') {
		return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillTree(v, vars, k)]));
	}
	return node;
}

const isHttpUrl = (s: unknown) => {
	if (typeof s !== 'string') return false;
	try {
		const u = new URL(s);
		return u.protocol === 'https:' || u.protocol === 'http:';
	} catch {
		return false;
	}
};

/** Drop link buttons whose URL is empty or not a URL after filling (no public address), and rows left empty. */
function dropDeadLinks(list: Component[]): Component[] {
	const out: Component[] = [];
	for (const c of list) {
		if (c.type === C.ActionRow && Array.isArray(c.components)) {
			const kept = (c.components as Component[]).filter((b) => b.type !== C.Button || isHttpUrl(b.url));
			if (kept.length > 0) out.push({ ...c, components: kept });
			continue;
		}
		if (c.type === C.Section && c.accessory && (c.accessory as Component).type === C.Button) {
			if (!isHttpUrl((c.accessory as Component).url)) {
				// A section needs an accessory; without the button it becomes its text.
				out.push(...((c.components as Component[]) ?? []));
				continue;
			}
		}
		if (c.type === C.Container && Array.isArray(c.components)) {
			out.push({ ...c, components: dropDeadLinks(c.components as Component[]) });
			continue;
		}
		out.push(c);
	}
	return out;
}

/** The components to send for one event: the mention first (so it pings), then the message. */
export function buildComponents(kind: EventKind, t: EventTemplate, vars: Vars): Component[] {
	let body: Component[];
	if (t.advanced && t.raw !== null) {
		const parsed = JSON.parse(t.raw) as Component[];
		body = dropDeadLinks(fillTree(parsed, vars) as Component[]);
	} else {
		body = fieldComponents(kind, t, vars);
	}
	return t.mention ? [{ type: C.TextDisplay, content: t.mention }, ...body] : body;
}

/** Who may be pinged: only the one mention in the template, never anything inside a value. */
export function allowedMentions(mention: string): { parse: string[]; roles?: string[]; users?: string[] } {
	const role = /^<@&(\d{1,20})>$/.exec(mention);
	if (role) return { parse: [], roles: [role[1] as string] };
	const user = /^<@!?(\d{1,20})>$/.exec(mention);
	if (user) return { parse: [], users: [user[1] as string] };
	if (mention === '@here' || mention === '@everyone') return { parse: ['everyone'] };
	return { parse: [] };
}

export type ComponentsPayload = {
	flags: number;
	components: Component[];
	allowed_mentions: ReturnType<typeof allowedMentions>;
};

export type EmbedPayload = {
	content?: string;
	embeds: {
		title?: string;
		description?: string;
		color: number;
		url?: string;
		footer: { text: string };
		timestamp: string;
	}[];
	allowed_mentions: ReturnType<typeof allowedMentions>;
};

export function componentsPayload(kind: EventKind, t: EventTemplate, vars: Vars): ComponentsPayload {
	return {
		flags: COMPONENTS_V2_FLAG,
		components: buildComponents(kind, t, vars),
		allowed_mentions: allowedMentions(t.mention)
	};
}

/** Every Text Display's text and every link button, in order, for the embed fallback and the checks. */
export function walk(list: Component[], fn: (c: Component, depth: number) => void, depth = 0): void {
	for (const c of list) {
		fn(c, depth);
		if (Array.isArray(c.components)) walk(c.components as Component[], fn, depth + 1);
		if (c.accessory && typeof c.accessory === 'object') walk([c.accessory as Component], fn, depth + 1);
	}
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The classic embed sent when a webhook refuses Components v2: the same heading, text, colour and link. From the
 * raw editor, the first Text Display that starts with `#` is the title and the rest is the description.
 */
export function embedPayload(kind: EventKind, t: EventTemplate, vars: Vars, now: number): EmbedPayload {
	let title = '';
	let description = '';
	let color = hexToInt(t.accent);
	let link = '';
	let linkLabel = BUTTON_LABELS[kind];
	if (t.advanced && t.raw !== null) {
		const comps = buildComponents(kind, { ...t, mention: '' }, vars);
		const texts: string[] = [];
		let colorSet = false;
		walk(comps, (c) => {
			if (c.type === C.Container && typeof c.accent_color === 'number' && !colorSet) {
				color = c.accent_color;
				colorSet = true;
			}
			if (c.type === C.TextDisplay && typeof c.content === 'string') texts.push(c.content);
			if (c.type === C.Button && typeof c.url === 'string' && !link) {
				link = c.url;
				if (typeof c.label === 'string') linkLabel = c.label;
			}
		});
		if (texts[0]?.startsWith('#')) title = (texts.shift() as string).replace(/^#+\s*/, '');
		description = texts.filter((x) => !x.startsWith('-# Caddy UI')).join('\n\n');
	} else {
		title = fill(t.heading, vars, { plain: true }).trim();
		description = fill(t.body, vars).trim();
		link = t.button ? (vars.values.url ?? '') : '';
	}
	if (link) description = `${description}${description ? '\n\n' : ''}[${linkLabel}](${link})`;
	const embed: EmbedPayload['embeds'][number] = {
		color,
		footer: { text: 'Caddy UI' },
		timestamp: new Date(now).toISOString()
	};
	if (title) embed.title = cut(title, 256);
	if (description) embed.description = cut(description, 4096);
	if (link) embed.url = link;
	const out: EmbedPayload = { embeds: [embed], allowed_mentions: allowedMentions(t.mention) };
	if (t.mention) out.content = t.mention;
	return out;
}

// ── checks ──────────────────────────────────────────────────────────────────────────────────────

const TOP_LEVEL = new Set<number>([
	C.ActionRow,
	C.Section,
	C.TextDisplay,
	C.MediaGallery,
	C.Separator,
	C.Container
]);
const IN_CONTAINER = new Set<number>([C.ActionRow, C.Section, C.TextDisplay, C.MediaGallery, C.Separator]);

/**
 * Check a components tree against what a webhook may send: only non-interactive types and link buttons, at most
 * 40 components and 4000 characters of text. Returns the first problem in words, or null.
 */
export function checkComponents(list: unknown): string | null {
	if (!Array.isArray(list)) return 'The JSON must be an array of components, such as [{"type": 17, …}].';
	if (list.length === 0) return 'Add at least one component.';
	let count = 0;
	let text = 0;
	const problem = (
		c: unknown,
		where: 'top' | 'container' | 'row' | 'section' | 'accessory'
	): string | null => {
		if (!c || typeof c !== 'object' || Array.isArray(c) || typeof (c as Component).type !== 'number') {
			return 'Each component must be an object with a numeric "type".';
		}
		const comp = c as Component;
		count++;
		const t = comp.type;
		if (where === 'top' && !TOP_LEVEL.has(t)) return `Type ${t} cannot be at the top level.`;
		if (where === 'container' && !IN_CONTAINER.has(t)) return `Type ${t} cannot be inside a container (17).`;
		if (where === 'row' && t !== C.Button) return 'An action row (1) may hold only link buttons (2).';
		if (where === 'section' && t !== C.TextDisplay) return 'A section (9) may hold only text displays (10).';
		if (where === 'accessory' && t !== C.Button && t !== C.Thumbnail) {
			return 'A section’s accessory must be a link button (2) or a thumbnail (11).';
		}
		switch (t) {
			case C.TextDisplay:
				if (typeof comp.content !== 'string' || comp.content.trim() === '') {
					return 'A text display (10) needs non-empty "content".';
				}
				text += comp.content.length;
				return null;
			case C.Button:
				if (comp.style !== LINK_STYLE) {
					return 'Only link buttons (style 5) can be sent by a webhook; other buttons need a bot.';
				}
				if (typeof comp.url !== 'string' || comp.url === '')
					return 'A link button needs a "url", such as "{url}".';
				if (comp.url.length > 512) return 'A button’s "url" may be at most 512 characters.';
				if (comp.label !== undefined && (typeof comp.label !== 'string' || comp.label.length > 80)) {
					return 'A button’s "label" must be text of at most 80 characters.';
				}
				if ('custom_id' in comp) return 'A link button cannot have a "custom_id".';
				return null;
			case C.ActionRow: {
				const kids = comp.components;
				if (!Array.isArray(kids) || kids.length === 0 || kids.length > 5) {
					return 'An action row (1) holds one to five link buttons.';
				}
				for (const k of kids) {
					const p = problem(k, 'row');
					if (p) return p;
				}
				return null;
			}
			case C.Section: {
				const kids = comp.components;
				if (!Array.isArray(kids) || kids.length === 0 || kids.length > 3) {
					return 'A section (9) holds one to three text displays.';
				}
				for (const k of kids) {
					const p = problem(k, 'section');
					if (p) return p;
				}
				if (!comp.accessory) return 'A section (9) needs an "accessory": a link button or a thumbnail.';
				return problem(comp.accessory, 'accessory');
			}
			case C.Container: {
				const kids = comp.components;
				if (!Array.isArray(kids) || kids.length === 0) return 'A container (17) needs "components".';
				if (comp.accent_color !== undefined && comp.accent_color !== null) {
					const a = comp.accent_color;
					if (typeof a !== 'number' || !Number.isInteger(a) || a < 0 || a > 0xffffff) {
						return '"accent_color" must be a whole number from 0 to 16777215 (0xFFFFFF).';
					}
				}
				for (const k of kids) {
					const p = problem(k, 'container');
					if (p) return p;
				}
				return null;
			}
			case C.Thumbnail:
			case C.MediaGallery:
			case C.Separator:
				return null;
			default:
				return `Type ${t} is not allowed: a webhook may send only non-interactive components and link buttons.`;
		}
	};
	for (const c of list) {
		const p = problem(c, 'top');
		if (p) return p;
	}
	// The mention and the test line add one component each; leave room for them.
	if (count > MAX_COMPONENTS - 2)
		return `At most ${MAX_COMPONENTS - 2} components (Discord allows 40 in all).`;
	if (text > MAX_TEXT - 200)
		return `At most ${MAX_TEXT - 200} characters of text in all, before placeholders are filled.`;
	return null;
}

const MENTION = /^(|<@&\d{1,20}>|<@!?\d{1,20}>|@here|@everyone)$/;

/** Check one template. Returns a message per field, empty when it is fine. */
export function checkTemplate(t: EventTemplate): Record<string, string> {
	const errors: Record<string, string> = {};
	if (t.heading.length > 200) errors.heading = 'At most 200 characters.';
	if (t.body.length > 2000) errors.body = 'At most 2000 characters.';
	if (!t.advanced && t.heading.trim() === '' && t.body.trim() === '') {
		errors.body = 'Write a heading or a text.';
	}
	if (!/^#[0-9a-f]{6}$/i.test(t.accent)) errors.accent = 'A colour such as #e5484d.';
	if (!MENTION.test(t.mention.trim())) {
		errors.mention = 'Leave empty, or use <@&role id>, <@user id>, @here or @everyone.';
	}
	if (t.raw !== null && new TextEncoder().encode(t.raw).length > MAX_RAW_BYTES) {
		errors.raw = 'At most 16 KB of JSON.';
	} else if (t.advanced) {
		if (t.raw === null || t.raw.trim() === '') errors.raw = 'Paste or write the components JSON.';
		else {
			let parsed: unknown;
			try {
				parsed = JSON.parse(t.raw);
			} catch (err) {
				errors.raw = `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
			}
			if (!errors.raw) {
				const p = checkComponents(parsed);
				if (p) errors.raw = p;
			}
		}
	}
	return errors;
}

/** Take a template from untrusted JSON (a request body or the saved row), filling gaps from the default. */
export function coerceTemplate(kind: EventKind, v: unknown): EventTemplate {
	const d = defaultTemplate(kind);
	if (!v || typeof v !== 'object' || Array.isArray(v)) return d;
	const o = v as Record<string, unknown>;
	const str = (x: unknown, fb: string) => (typeof x === 'string' ? x : fb);
	const bool = (x: unknown, fb: boolean) => (typeof x === 'boolean' ? x : fb);
	return {
		enabled: bool(o.enabled, d.enabled),
		heading: str(o.heading, d.heading),
		body: str(o.body, d.body),
		accent: str(o.accent, d.accent),
		mention: str(o.mention, d.mention).trim(),
		button: bool(o.button, d.button),
		advanced: bool(o.advanced, d.advanced),
		raw: typeof o.raw === 'string' ? o.raw : null
	};
}

/** A down duration for `{duration}`. */
export const formatDuration = (ms: number) => formatElapsed(ms);
