import type {
	DeliveryFormat,
	EventKind,
	EventTemplate,
	NotifyConfig,
	NotifyError,
	NotifyPatch,
	NotifyTestRequest,
	NotifyTestResult,
	NotifyView
} from '$lib/notify/types';
import { EVENTS, isEventKind } from '$lib/notify/types';
import {
	C,
	checkTemplate,
	coerceTemplate,
	componentsPayload,
	defaultTemplate,
	embedPayload,
	EVENT_LABELS,
	expiresIn,
	formatDuration,
	makeVars,
	sameTemplate,
	sampleVars,
	uiLink,
	type Vars
} from '$lib/notify/templates';
import type { Db } from '../db';
import { DiscordSender, parseWebhookUrl, WebhookUrlError, type SendResult, type WebhookRef } from './discord';
import { DOWN_CYCLES, FLAP_MINUTES, K, NotifyStore } from './store';

/**
 * Turns what the collector, the config service and the boot see into Discord messages
 * (docs/settings-and-perf-plan.md §3.1). It never blocks probing: every send runs in the background, and a
 * failure is written to the delivery log, which Settings (and S3's Diagnostics) show.
 *
 * Site and upstream state is judged here, not from the collector's flips: "down" needs `downCycles` failed
 * cycles in a row, and each site or upstream gets at most one message per `flapMinutes`. A change held back by
 * that limit is sent when the window ends if it still holds, so the last word in the channel is always right.
 */

export type ProbeState = 'up' | 'down' | 'unknown';

/** One target's result in a probe cycle: `target` '' is the site itself, else an upstream address. */
export type CycleEntry = {
	siteId: string;
	target: string;
	state: ProbeState;
	status: number | null;
	error: string | null;
};

export type SiteInfo = { id: string; addresses: string[] };

export type CertSeen = { host: string; notAfter: number; issuer: string };

export class NotifyRefused extends Error {
	constructor(
		readonly status: 400 | 409,
		readonly body: NotifyError
	) {
		super(body.message);
		this.name = 'NotifyRefused';
	}
}

export type NotifierOptions = {
	db: Db;
	sender: DiscordSender;
	/** The UI's version, for "update applied" and "rolled back". */
	version: string;
	/** Read per use: the time zone and public address can change in Settings while the UI runs. */
	display: () => { timeZone: string; publicUrl: string | undefined };
	/** Certificate warning window in days; 14 until S3 makes it a setting. */
	warnDays?: () => number;
	now?: () => number;
};

type Tracker = {
	/** What the channel was last told (or would have been, with the event off). */
	reported: 'up' | 'down';
	/** What the probes say once the threshold is applied. */
	confirmed: 'up' | 'down';
	fails: number;
	firstFail: number | null;
	downSince: number | null;
	recoveredAt: number | null;
	lastSentAt: number;
	status: number | null;
	error: string | null;
	/** Upstreams: the sites that use it. */
	sites: string[];
	siteId: string;
	address: string;
};

const DAY = 86_400_000;
const MIN = 60_000;
const DEFAULT_WARN_DAYS = 14;
const LAST_WARN_DAYS = 3;

const siteName = (s: SiteInfo | undefined, id: string) => (s ? s.addresses.join(', ') : id);

/** Compare `1.2.0` with `1.10.3`; null when either is not a version number (`edge`, a commit). */
export function compareVersions(a: string, b: string): number | null {
	const p = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number);
	const x = p(a);
	const y = p(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++)
		if ((x[i] as number) !== (y[i] as number)) return (x[i] as number) - (y[i] as number);
	return 0;
}

export class Notifier {
	readonly store: NotifyStore;
	readonly #sender: DiscordSender;
	readonly #version: string;
	readonly #display: NotifierOptions['display'];
	readonly #warnDays: () => number;
	readonly #now: () => number;
	#config: NotifyConfig;
	#trackers = new Map<string, Tracker>();
	/** Sends started and not finished; tests wait on these. */
	#inflight = new Set<Promise<unknown>>();

	constructor(opts: NotifierOptions) {
		this.store = new NotifyStore(opts.db);
		this.#sender = opts.sender;
		this.#version = opts.version;
		this.#display = opts.display;
		this.#warnDays = opts.warnDays ?? (() => DEFAULT_WARN_DAYS);
		this.#now = opts.now ?? Date.now;
		this.#config = this.store.config();
	}

	get config(): NotifyConfig {
		return this.#config;
	}

	/** Resolves when every send started so far has finished. */
	async idle(): Promise<void> {
		while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
	}

	// ── sending ─────────────────────────────────────────────────────────────────────────────────

	#webhook(): WebhookRef | null {
		const url = this.store.get(K.webhook);
		if (!url) return null;
		try {
			return parseWebhookUrl(url);
		} catch {
			return null;
		}
	}

	#build(kind: EventKind, t: EventTemplate, vars: Vars, test: boolean) {
		const now = this.#now();
		return (format: DeliveryFormat) => {
			if (format === 'embed') {
				const p = embedPayload(kind, t, vars, now);
				if (test) for (const e of p.embeds) e.footer.text = 'Caddy UI · test message with sample values';
				return p;
			}
			const p = componentsPayload(kind, t, vars);
			if (test) p.components.push({ type: C.TextDisplay, content: '-# Test message with sample values' });
			return p;
		};
	}

	async #deliver(
		webhook: WebhookRef,
		kind: EventKind,
		subject: string,
		t: EventTemplate,
		vars: Vars,
		test: boolean
	): Promise<SendResult> {
		const preferEmbed = this.store.get(K.embedSince) !== undefined;
		const result = await this.#sender.send(webhook, this.#build(kind, t, vars, test), preferEmbed);
		if (result.ok && result.fellBack && webhook.id === this.#webhook()?.id) {
			this.store.set(K.embedSince, String(this.#now()));
		}
		this.store.record({
			ts: this.#now(),
			event: kind,
			subject,
			ok: result.ok,
			status: result.status,
			format: result.format,
			attempts: result.attempts,
			error: result.error,
			test
		});
		if (!result.ok)
			console.warn(`caddy-ui notifications: ${EVENT_LABELS[kind]} (${subject}) not sent: ${result.error}`);
		return result;
	}

	/** Send an event in the background when it is switched on and a webhook is saved. Returns whether it was sent. */
	#emit(kind: EventKind, subject: string, vars: Vars): boolean {
		const t = this.#config.events[kind];
		const webhook = this.#webhook();
		if (!t.enabled || !webhook) return false;
		const p = this.#deliver(webhook, kind, subject, t, vars, false).catch((err) =>
			console.error('caddy-ui notifications:', err)
		);
		this.#inflight.add(p);
		void p.finally(() => this.#inflight.delete(p));
		return true;
	}

	#link(path: string): string {
		return uiLink(this.#display().publicUrl, path);
	}

	#vars(values: Record<string, string>, at: Parameters<typeof makeVars>[1]): Vars {
		return makeVars(values, at, this.#display().timeZone);
	}

	// ── probe cycles ────────────────────────────────────────────────────────────────────────────

	/**
	 * Start from what the collector knew at boot, so a restart neither repeats "down" for a site already reported
	 * nor forgets to say it is back. Keys are `site|<id>` and `upstream|<address>`.
	 */
	seed(states: ReadonlyMap<string, { state: string; since: number }>, sites: SiteInfo[]): void {
		const byId = new Map(sites.map((s) => [s.id, s]));
		for (const [key, { state, since }] of states) {
			if (state !== 'down' && state !== 'up') continue;
			const [siteId, target] = key.split('|') as [string, string];
			const k = target ? `upstream|${target}` : `site|${siteId}`;
			const existing = this.#trackers.get(k);
			if (existing) {
				existing.sites = [...new Set([...existing.sites, siteName(byId.get(siteId), siteId)])];
				continue;
			}
			this.#trackers.set(k, {
				reported: state,
				confirmed: state,
				fails: state === 'down' ? this.#config.downCycles : 0,
				firstFail: state === 'down' ? since : null,
				downSince: state === 'down' ? since : null,
				recoveredAt: null,
				lastSentAt: 0,
				status: null,
				error: null,
				sites: [siteName(byId.get(siteId), siteId)],
				siteId,
				address: target
			});
		}
	}

	/** Called after each probe cycle with every result of it. */
	onCycle(ts: number, entries: CycleEntry[], sites: SiteInfo[]): void {
		const byId = new Map(sites.map((s) => [s.id, s]));
		const seen = new Map<string, { entry: CycleEntry; sites: string[] }>();
		for (const e of entries) {
			if (e.state === 'unknown') continue;
			const key = e.target ? `upstream|${e.target}` : `site|${e.siteId}`;
			const name = siteName(byId.get(e.siteId), e.siteId);
			const had = seen.get(key);
			if (had) {
				if (!had.sites.includes(name)) had.sites.push(name);
			} else seen.set(key, { entry: e, sites: [name] });
		}
		for (const key of [...this.#trackers.keys()]) if (!seen.has(key)) this.#trackers.delete(key);

		const flapMs = this.#config.flapMinutes * MIN;
		for (const [key, { entry, sites: names }] of seen) {
			let t = this.#trackers.get(key);
			if (!t) {
				t = {
					reported: 'up',
					confirmed: 'up',
					fails: 0,
					firstFail: null,
					downSince: null,
					recoveredAt: null,
					lastSentAt: 0,
					status: null,
					error: null,
					sites: names,
					siteId: entry.siteId,
					address: entry.target
				};
				this.#trackers.set(key, t);
			}
			t.sites = names;
			t.status = entry.status;
			if (entry.state === 'down') {
				t.error = entry.error;
				t.fails++;
				if (t.fails === 1) t.firstFail = ts;
				if (t.fails >= this.#config.downCycles) {
					if (t.confirmed === 'up') t.recoveredAt = null;
					t.confirmed = 'down';
				}
			} else {
				if (t.confirmed === 'down' && t.recoveredAt === null) t.recoveredAt = ts;
				t.fails = 0;
				t.confirmed = 'up';
			}
			if (t.confirmed === t.reported) continue;
			if (flapMs > 0 && t.lastSentAt > 0 && this.#now() - t.lastSentAt < flapMs) continue;
			this.#announce(key, t, ts);
		}
	}

	#announce(key: string, t: Tracker, ts: number): void {
		const upstream = key.startsWith('upstream|');
		const site = t.sites.join(', ');
		let sent: boolean;
		if (t.confirmed === 'down') {
			t.downSince = t.firstFail ?? ts;
			const status = t.status ? `HTTP ${t.status}` : 'no answer';
			const values = {
				site,
				status,
				error: t.error ?? status,
				upstream: t.address,
				url: this.#link(upstream ? '/sites' : `/sites/${t.siteId}`)
			};
			sent = this.#emit(
				upstream ? 'upstream_down' : 'site_down',
				upstream ? t.address : site,
				this.#vars(values, { since: t.downSince, time: ts })
			);
		} else {
			const since = t.downSince ?? ts;
			const back = t.recoveredAt ?? ts;
			const values = {
				site,
				status: t.status ? `HTTP ${t.status}` : 'it answers',
				duration: formatDuration(back - since),
				upstream: t.address,
				url: this.#link(upstream ? '/sites' : `/sites/${t.siteId}`)
			};
			sent = this.#emit(
				upstream ? 'upstream_up' : 'site_up',
				upstream ? t.address : site,
				this.#vars(values, { since, time: back })
			);
			t.downSince = null;
			t.recoveredAt = null;
		}
		t.reported = t.confirmed;
		if (sent) t.lastSentAt = this.#now();
	}

	// ── certificates ────────────────────────────────────────────────────────────────────────────

	/**
	 * Called after each certificate scan. A certificate of a site in the Caddyfile is warned about once when it
	 * enters the warning window and once more with 3 days left; a renewed one (a later expiry) starts over.
	 * Certificates of sites no longer in the Caddyfile stay in Caddy's storage until they expire and are skipped.
	 */
	onCerts(certs: CertSeen[], siteFor: (host: string) => string | undefined): void {
		const now = this.#now();
		const warnMs = this.#warnDays() * DAY;
		let done: Record<string, { notAfter: number; stage: number }> = {};
		try {
			done = JSON.parse(this.store.get(K.certs) ?? '{}') as typeof done;
		} catch {
			done = {};
		}
		const next: typeof done = {};
		for (const c of certs) {
			const siteId = siteFor(c.host);
			if (!siteId) continue;
			const left = c.notAfter - now;
			const stage = left <= LAST_WARN_DAYS * DAY ? 2 : left < warnMs ? 1 : 0;
			const prev = done[c.host];
			let reached = prev && prev.notAfter === c.notAfter ? prev.stage : 0;
			if (stage > reached) {
				const values = {
					site: c.host,
					days_left: String(Math.max(0, Math.floor(left / DAY))),
					expires_in: left <= 0 ? '0 days: it has expired' : expiresIn(left),
					issuer: c.issuer || 'an unknown issuer',
					url: this.#link(`/sites/${siteId}`)
				};
				if (this.#emit('cert_expiring', c.host, this.#vars(values, { expires: c.notAfter, time: now }))) {
					reached = stage;
				}
			}
			if (reached > 0) next[c.host] = { notAfter: c.notAfter, stage: reached };
		}
		const text = Object.keys(next).length > 0 ? JSON.stringify(next) : null;
		if (text !== (this.store.get(K.certs) ?? null)) this.store.set(K.certs, text);
	}

	// ── Caddyfile and version ───────────────────────────────────────────────────────────────────

	/** The config service saw an edit made outside the UI (also one made while the UI was stopped). */
	onExternalEdit(change: { at: number; revisionId: number | null }): void {
		const revision = change.revisionId === null ? 'the newest' : `#${change.revisionId}`;
		const values = { revision, url: this.#link('/history') };
		this.#emit('caddyfile_external', `revision ${revision}`, this.#vars(values, { time: change.at }));
	}

	/**
	 * At boot: compare this version with the one that ran last. A newer one is "update applied", an older one
	 * "rolled back". Development and CI builds are not versions and are skipped.
	 */
	checkVersion(): void {
		const cur = this.#version.trim();
		if (!cur || cur === 'dev' || cur.startsWith('ci-')) return;
		const prev = this.store.get(K.lastVersion);
		if (prev === cur) return;
		this.store.set(K.lastVersion, cur);
		if (!prev) return;
		const cmp = compareVersions(cur, prev);
		const kind: EventKind = cmp !== null && cmp < 0 ? 'update_rolled_back' : 'update_applied';
		const values = { version: cur, previous_version: prev, url: this.#link('/') };
		this.#emit(kind, cur, this.#vars(values, { time: this.#now() }));
	}

	// ── settings ────────────────────────────────────────────────────────────────────────────────

	view(): NotifyView {
		const webhook = this.#webhook();
		const embed = this.store.get(K.embedSince);
		const { timeZone, publicUrl } = this.#display();
		return {
			webhook: {
				set: webhook !== null,
				id: webhook?.id ?? null,
				embedSince: embed ? Number(embed) : null
			},
			config: this.#config,
			customized: EVENTS.filter((k) => !sameTemplate(this.#config.events[k], defaultTemplate(k))),
			publicUrl: publicUrl ?? null,
			timeZone,
			deliveries: this.store.deliveries()
		};
	}

	/** Check the whole patch, then save it in one transaction with a settings-log row per change. */
	update(patch: NotifyPatch, author: string): NotifyView {
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new NotifyRefused(400, { message: 'Send a JSON object', code: 'INVALID' });
		}
		const errors: Record<string, string> = {};
		const next: NotifyConfig = {
			...this.#config,
			events: { ...this.#config.events }
		};
		let webhookUrl: string | null | undefined;
		if (patch.webhook !== undefined) {
			if (patch.webhook === null || patch.webhook.trim() === '') webhookUrl = null;
			else if (typeof patch.webhook !== 'string') errors.webhook = 'Send the webhook URL as text.';
			else {
				try {
					const ref = parseWebhookUrl(patch.webhook);
					webhookUrl = `https://discord.com/api/webhooks/${ref.id}/${ref.token}`;
				} catch (err) {
					errors.webhook = err instanceof WebhookUrlError ? err.message : String(err);
				}
			}
		}
		const int = (v: unknown, name: 'downCycles' | 'flapMinutes', r: { min: number; max: number }) => {
			if (v === undefined) return;
			if (typeof v !== 'number' || !Number.isInteger(v) || v < r.min || v > r.max) {
				errors[name] = `A whole number from ${r.min} to ${r.max}.`;
				return;
			}
			next[name] = v;
		};
		int(patch.downCycles, 'downCycles', DOWN_CYCLES);
		int(patch.flapMinutes, 'flapMinutes', FLAP_MINUTES);
		if (patch.events !== undefined) {
			if (!patch.events || typeof patch.events !== 'object') errors.events = 'Send events as an object.';
			else {
				for (const [k, v] of Object.entries(patch.events)) {
					if (!isEventKind(k)) {
						errors[`events.${k}`] = `${k} is not an event.`;
						continue;
					}
					if (v === null) {
						next.events[k] = defaultTemplate(k);
						continue;
					}
					const t = coerceTemplate(k, v);
					const problems = checkTemplate(t);
					for (const [field, msg] of Object.entries(problems)) errors[`events.${k}.${field}`] = msg;
					next.events[k] = t;
				}
			}
		}
		const keys = Object.keys(errors);
		if (keys.length > 0) {
			throw new NotifyRefused(400, {
				message:
					keys.length === 1 ? (errors[keys[0] as string] as string) : `${keys.length} values are not valid`,
				code: 'INVALID',
				errors
			});
		}

		const ts = this.#now();
		const prev = this.#config;
		const describe = (k: EventKind, t: EventTemplate) =>
			`${t.enabled ? 'on' : 'off'}${sameTemplate(t, defaultTemplate(k)) ? '' : ', edited'}`;
		this.store.transaction(() => {
			if (webhookUrl !== undefined) {
				const old = this.#webhook();
				const now = webhookUrl ? parseWebhookUrl(webhookUrl) : null;
				if (old?.id !== now?.id || old?.token !== now?.token) {
					this.store.set(K.webhook, webhookUrl);
					this.store.set(K.embedSince, null);
					this.store.logChange(
						ts,
						author,
						'notify.webhook',
						old ? `webhook ${old.id}` : null,
						now ? `webhook ${now.id}` : null
					);
				}
			}
			if (patch.retryComponents) this.store.set(K.embedSince, null);
			if (next.downCycles !== prev.downCycles) {
				this.store.logChange(
					ts,
					author,
					'notify.down_cycles',
					String(prev.downCycles),
					String(next.downCycles)
				);
			}
			if (next.flapMinutes !== prev.flapMinutes) {
				this.store.logChange(
					ts,
					author,
					'notify.flap_minutes',
					String(prev.flapMinutes),
					String(next.flapMinutes)
				);
			}
			for (const k of EVENTS) {
				if (!sameTemplate(prev.events[k], next.events[k])) {
					const a = describe(k, prev.events[k]);
					const b = describe(k, next.events[k]);
					this.store.logChange(ts, author, `notify.${k}`, a, a === b ? `${b}, changed` : b);
				}
			}
			this.store.saveConfig(next);
		});
		this.#config = this.store.config();
		return this.view();
	}

	/** "Send test": one event with sample values, to the typed webhook or the saved one, typed template or saved. */
	async test(req: NotifyTestRequest): Promise<NotifyTestResult> {
		if (!req || !isEventKind(req.event)) {
			throw new NotifyRefused(400, { message: 'Name an event to test', code: 'INVALID' });
		}
		let webhook: WebhookRef | null;
		if (typeof req.webhook === 'string' && req.webhook.trim() !== '') {
			try {
				webhook = parseWebhookUrl(req.webhook);
			} catch (err) {
				throw new NotifyRefused(400, {
					message: err instanceof Error ? err.message : String(err),
					code: 'INVALID',
					errors: { webhook: err instanceof Error ? err.message : String(err) }
				});
			}
		} else webhook = this.#webhook();
		if (!webhook) {
			throw new NotifyRefused(409, {
				message: 'Save a webhook URL first, or paste one to test with',
				code: 'NO_WEBHOOK'
			});
		}
		const t = req.template ? coerceTemplate(req.event, req.template) : this.#config.events[req.event];
		const problems = checkTemplate(t);
		if (Object.keys(problems).length > 0) {
			const errors = Object.fromEntries(
				Object.entries(problems).map(([f, m]) => [`events.${req.event}.${f}`, m])
			);
			throw new NotifyRefused(400, {
				message: Object.values(problems)[0] as string,
				code: 'INVALID',
				errors
			});
		}
		const { timeZone, publicUrl } = this.#display();
		const vars = sampleVars(req.event, { now: this.#now(), publicUrl: publicUrl ?? null, timeZone });
		const r = await this.#deliver(webhook, req.event, 'sample values', t, vars, true);
		return { ok: r.ok, format: r.format, status: r.status, error: r.error, fellBack: r.fellBack };
	}
}

export { isEventKind };
