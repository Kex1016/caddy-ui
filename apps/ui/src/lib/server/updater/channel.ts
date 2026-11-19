import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
	UpdateResult,
	UpdateTrigger,
	UpdaterLastRun,
	UpdaterStatus,
	UpdatesView
} from '$lib/api/updates';

/**
 * The file channel to the updater sidecar (docs/settings-and-perf-plan.md D13): no new port, no Docker socket in
 * the UI. `control.json` is ours (interval, "check now"); `status.json` is the updater's. Both are small and
 * replaced atomically. The updater reads control.json every few seconds (CADDY_UI_UPDATE_POLL), so a change
 * lands within one poll. Nothing here throws on a missing or damaged file: the page just shows what it can.
 */

export const CONTROL_FILE = 'control.json';
export const STATUS_FILE = 'status.json';

export type Control = {
	version: 1;
	/** `30s`, `5m`, `1h`, `1d`: what the UI saved. null means "use the updater's own environment". */
	interval: string | null;
	/** An opaque token. A token the updater has not handled yet is a request to check now. */
	checkNow: string | null;
	writtenAt: string;
};

const RESULTS: readonly UpdateResult[] = [
	'up-to-date',
	'updated',
	'rolled-back',
	'needs-attention',
	'failed'
];
const TRIGGERS: readonly UpdateTrigger[] = ['timer', 'check-now', 'webhook', 'manual'];

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown, fallback: number): number =>
	typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export function readControl(dir: string): Control {
	const raw = readJson(join(dir, CONTROL_FILE));
	const c = isObj(raw) ? raw : {};
	return {
		version: 1,
		interval: text(c.interval),
		checkNow: text(c.checkNow),
		writtenAt: text(c.writtenAt) ?? ''
	};
}

/** The updater's status, cleaned. null when there is no file or it is not what we expect. */
export function readStatus(dir: string): UpdaterStatus | null {
	const raw = readJson(join(dir, STATUS_FILE));
	if (!isObj(raw)) return null;
	const updatedAt = text(raw.updatedAt);
	if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) return null;
	let lastRun: UpdaterLastRun | null = null;
	if (isObj(raw.lastRun)) {
		const r = raw.lastRun;
		const result = text(r.result) as UpdateResult | null;
		const trigger = text(r.trigger) as UpdateTrigger | null;
		if (result && RESULTS.includes(result) && text(r.startedAt) && text(r.finishedAt)) {
			lastRun = {
				startedAt: r.startedAt as string,
				finishedAt: r.finishedAt as string,
				trigger: trigger && TRIGGERS.includes(trigger) ? trigger : 'manual',
				result,
				message: text(r.message) ?? ''
			};
		}
	}
	let latest: UpdaterStatus['latest'] = null;
	if (isObj(raw.latest)) {
		const version = text(raw.latest.version);
		const id = text(raw.latest.id);
		if (version || id) latest = { version: version ?? '', id: id ?? '' };
	}
	return {
		updatedAt,
		source: text(raw.source) ?? 'ghcr',
		pollSeconds: num(raw.pollSeconds, 5),
		checking: raw.checking === true,
		intervalSeconds: num(raw.intervalSeconds, 0),
		intervalFrom: raw.intervalFrom === 'control' ? 'control' : 'env',
		nextCheckAt: text(raw.nextCheckAt),
		checkNowHandled: text(raw.checkNowHandled),
		warning: text(raw.warning),
		latest,
		lastRun
	};
}

/** Whether we can write into `dir` (or create it, when it is missing). Returns a reason when we cannot. */
export function channelProblem(dir: string): string | null {
	try {
		accessSync(dir, constants.W_OK);
		return null;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			try {
				accessSync(dirname(dir), constants.W_OK);
				return null;
			} catch {
				return `${dir} does not exist and cannot be created`;
			}
		}
		return `${dir} is not writable`;
	}
}

function writeAtomic(dir: string, name: string, body: string): void {
	const tmp = join(dir, `.${name}.${randomBytes(4).toString('hex')}`);
	writeFileSync(tmp, body, { mode: 0o644 });
	renameSync(tmp, join(dir, name));
}

/** Write control.json, keeping the fields the patch leaves out. Throws when the directory cannot be written. */
export function writeControl(dir: string, patch: Partial<Pick<Control, 'interval' | 'checkNow'>>): Control {
	mkdirSync(dir, { recursive: true });
	const next: Control = { ...readControl(dir), ...patch, version: 1, writtenAt: new Date().toISOString() };
	writeAtomic(dir, CONTROL_FILE, JSON.stringify(next, null, 2) + '\n');
	return next;
}

/** Ask the updater to check now. Returns the token the updater will echo as `checkNowHandled`. */
export function requestCheckNow(dir: string): string {
	const token = randomBytes(8).toString('hex');
	writeControl(dir, { checkNow: token });
	return token;
}

/**
 * Make control.json say the same as the Settings: the saved interval, or null to hand the choice back to the
 * updater's environment. Does nothing (and creates nothing) when the file already agrees, or when there is nothing
 * to say and no file. Returns whether it wrote.
 */
export function syncInterval(dir: string, interval: string | null): boolean {
	const current = readControl(dir);
	if (current.interval === interval) return false;
	if (interval === null && current.writtenAt === '') return false;
	writeControl(dir, { interval });
	return true;
}

/** An updater that has not written for this many polls (and at least 30 s) is taken to be stopped. */
export function staleAfterMs(status: UpdaterStatus): number {
	return Math.max(30_000, status.pollSeconds * 6 * 1000);
}

export function updatesView(dir: string, version: string, now = Date.now()): UpdatesView {
	const problem = channelProblem(dir);
	const control = readControl(dir);
	const status = readStatus(dir);
	const base = { dir, version, now, requestedInterval: control.interval };
	if (problem) return { ...base, state: 'no-channel', problem, status: null, checkPending: false };
	if (!status) {
		return {
			...base,
			state: 'waiting',
			problem: null,
			status: null,
			checkPending: control.checkNow !== null
		};
	}
	const stale = now - Date.parse(status.updatedAt) > staleAfterMs(status);
	return {
		...base,
		state: stale ? 'stale' : 'ok',
		problem: null,
		status,
		checkPending: control.checkNow !== null && control.checkNow !== status.checkNowHandled
	};
}
