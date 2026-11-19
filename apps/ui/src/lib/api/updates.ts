/**
 * What the Settings page shows about the updater sidecar (docs/settings-and-perf-plan.md §3, D13). Client-safe.
 * The updater writes `status.json`; the UI writes `control.json`; both live in one directory they share.
 */

export type UpdateResult = 'up-to-date' | 'updated' | 'rolled-back' | 'needs-attention' | 'failed';
export type UpdateTrigger = 'timer' | 'check-now' | 'webhook' | 'manual';

export type UpdaterLastRun = {
	startedAt: string;
	finishedAt: string;
	trigger: UpdateTrigger;
	result: UpdateResult;
	message: string;
};

/** What the updater last wrote, cleaned up. Every field can be missing in a file from another version. */
export type UpdaterStatus = {
	updatedAt: string;
	source: 'ghcr' | 'git' | string;
	pollSeconds: number;
	checking: boolean;
	intervalSeconds: number;
	/** Where the interval in force came from: the UI's control file, or the updater's own environment. */
	intervalFrom: 'control' | 'env';
	nextCheckAt: string | null;
	/** The "check now" request the updater has handled. */
	checkNowHandled: string | null;
	warning: string | null;
	latest: { version: string; id: string } | null;
	lastRun: UpdaterLastRun | null;
};

/**
 * The state of the channel, for the page.
 * - `no-channel`: the directory cannot be written, so nothing can be sent to the updater.
 * - `waiting`: the directory works, but the updater has never written a status (not running, or another directory).
 * - `stale`: the status is older than a few polls; the updater has probably stopped.
 * - `ok`: the status is fresh.
 */
export type UpdaterState = 'no-channel' | 'waiting' | 'stale' | 'ok';

export type UpdatesView = {
	state: UpdaterState;
	/** Why the channel cannot be used, for `no-channel`. */
	problem: string | null;
	dir: string;
	/** This UI's own version (the image tag baked in at build time). */
	version: string;
	status: UpdaterStatus | null;
	/** The interval the UI last asked for (control.json), or null when the updater's environment applies. */
	requestedInterval: string | null;
	/** A "check now" was asked for and the updater has not picked it up yet. */
	checkPending: boolean;
	/** When the status was read, so the page can say how old it is. */
	now: number;
};
