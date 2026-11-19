import type { Delivery, DeliveryFormat, EventKind, EventTemplate, NotifyConfig } from '$lib/notify/types';
import { EVENTS, isEventKind } from '$lib/notify/types';
import { coerceTemplate, defaultConfig, defaultTemplate, sameTemplate } from '$lib/notify/templates';
import type { Db } from '../db';

/**
 * Where notification settings live (D19): rows in the shared `settings` table under `notify.`, beside S1's `cfg.`
 * rows, and the delivery log in `notify_log` (migration 7).
 *
 * - `notify.webhook`: the webhook URL. Write-only: it is read here to send and never leaves the server.
 * - `notify.config`: JSON with the thresholds and only the events that differ from the default, so a better
 *   default in a later version reaches every event nobody edited.
 * - `notify.embed_since`: when the webhook refused Components v2 (epoch ms); cleared with a new webhook.
 * - `notify.last_version`: the version that ran last, for "update applied" and "rolled back".
 * - `notify.certs`: certificates already warned about, so a restart does not warn again.
 */

export const NOTIFY_PREFIX = 'notify.';
export const K = {
	webhook: 'notify.webhook',
	config: 'notify.config',
	embedSince: 'notify.embed_since',
	lastVersion: 'notify.last_version',
	certs: 'notify.certs'
} as const;

const LOG_KEEP = 200;

/** `notify.config` as saved. Version 1. */
export type StoredConfig = {
	version: 1;
	downCycles?: number;
	flapMinutes?: number;
	events?: Partial<Record<EventKind, EventTemplate>>;
};

export const DOWN_CYCLES = { min: 1, max: 20 };
export const FLAP_MINUTES = { min: 0, max: 240 };

const clampInt = (v: unknown, lo: number, hi: number, fb: number) =>
	typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fb;

/** Read a saved config; anything missing or not understood falls back to the default (D11's spirit). */
export function parseStored(text: string | undefined): NotifyConfig {
	const out = defaultConfig();
	if (!text) return out;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		console.warn('caddy-ui notifications: the saved settings are not valid JSON; using the defaults');
		return out;
	}
	if (!raw || typeof raw !== 'object') return out;
	const r = raw as Record<string, unknown>;
	out.downCycles = clampInt(r.downCycles, DOWN_CYCLES.min, DOWN_CYCLES.max, out.downCycles);
	out.flapMinutes = clampInt(r.flapMinutes, FLAP_MINUTES.min, FLAP_MINUTES.max, out.flapMinutes);
	const events = r.events && typeof r.events === 'object' ? (r.events as Record<string, unknown>) : {};
	for (const [k, v] of Object.entries(events)) if (isEventKind(k)) out.events[k] = coerceTemplate(k, v);
	return out;
}

/** The config as saved: thresholds, and the events that differ from the default. */
export function toStored(c: NotifyConfig): StoredConfig {
	const d = defaultConfig();
	const s: StoredConfig = { version: 1 };
	if (c.downCycles !== d.downCycles) s.downCycles = c.downCycles;
	if (c.flapMinutes !== d.flapMinutes) s.flapMinutes = c.flapMinutes;
	const events: Partial<Record<EventKind, EventTemplate>> = {};
	for (const k of EVENTS) if (!sameTemplate(c.events[k], defaultTemplate(k))) events[k] = c.events[k];
	if (Object.keys(events).length > 0) s.events = events;
	return s;
}

export class NotifyStore {
	constructor(private readonly db: Db) {}

	transaction(fn: () => void): void {
		this.db.transaction(fn)();
	}

	get(key: string): string | undefined {
		const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
			{ value: string } | undefined;
		return row?.value;
	}

	set(key: string, value: string | null): void {
		if (value === null) this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
		else
			this.db
				.prepare(
					`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`
				)
				.run(key, value);
	}

	config(): NotifyConfig {
		return parseStored(this.get(K.config));
	}

	saveConfig(c: NotifyConfig): void {
		const s = toStored(c);
		this.set(K.config, Object.keys(s).length > 1 ? JSON.stringify(s) : null);
	}

	/** One row in the settings log, so Settings' "Recent changes" lists notification changes too (never the URL). */
	logChange(ts: number, author: string, key: string, oldValue: string | null, newValue: string | null): void {
		this.db
			.prepare(`INSERT INTO settings_log (ts, author, key, old_value, new_value) VALUES (?, ?, ?, ?, ?)`)
			.run(ts, author, key, oldValue, newValue);
	}

	record(d: Omit<Delivery, 'id'>): void {
		this.db
			.prepare(
				`INSERT INTO notify_log (ts, event, subject, ok, status, format, attempts, error, test)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(d.ts, d.event, d.subject, d.ok ? 1 : 0, d.status, d.format, d.attempts, d.error, d.test ? 1 : 0);
		this.db.prepare(`DELETE FROM notify_log WHERE id <= (SELECT MAX(id) FROM notify_log) - ?`).run(LOG_KEEP);
	}

	deliveries(limit = 20): Delivery[] {
		const rows = this.db
			.prepare(
				`SELECT id, ts, event, subject, ok, status, format, attempts, error, test FROM notify_log ORDER BY id DESC LIMIT ?`
			)
			.all(limit) as {
			id: number;
			ts: number;
			event: string;
			subject: string;
			ok: number;
			status: number | null;
			format: string;
			attempts: number;
			error: string | null;
			test: number;
		}[];
		return rows
			.filter((r) => isEventKind(r.event))
			.map((r) => ({
				id: r.id,
				ts: r.ts,
				event: r.event as EventKind,
				subject: r.subject,
				ok: r.ok === 1,
				status: r.status,
				format: r.format as DeliveryFormat,
				attempts: r.attempts,
				error: r.error,
				test: r.test === 1
			}));
	}
}
