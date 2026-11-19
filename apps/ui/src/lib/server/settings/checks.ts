import { accessSync, constants, statSync, type Stats } from 'node:fs';
import type { PathCheck } from '$lib/settings/types';
import type { Config } from '../env';

/**
 * Health checks for the environment's paths (docs/settings-and-perf-plan.md §2.1: "shown with a health check:
 * exists, readable, writable"). Each one asks for what the UI actually does with the path, so a read-only
 * Caddyfile mount is an error but a read-only Caddy data directory is fine. A few `stat` and `access` calls.
 */

function stat(path: string): Stats | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function can(path: string, mode: number): boolean {
	try {
		accessSync(path, mode);
		return true;
	} catch {
		return false;
	}
}

export function pathChecks(cfg: Config): PathCheck[] {
	return [caddyfile(cfg.caddyfilePath), accessLog(cfg.logPath), caddyData(cfg.dataPath), uiData(cfg.uiData)];
}

function caddyfile(path: string): PathCheck {
	const key = 'CADDYFILE_PATH';
	const s = stat(path);
	if (!s) return { key, path, state: 'error', message: 'Not found. Mount the Caddyfile at this path.' };
	if (!s.isFile()) return { key, path, state: 'error', message: 'This is not a file.' };
	if (!can(path, constants.R_OK))
		return { key, path, state: 'error', message: 'Found, but it cannot be read.' };
	if (!can(path, constants.W_OK)) {
		return {
			key,
			path,
			state: 'error',
			message: 'Found and readable, but not writable, so changes cannot be saved. Mount it read-write.'
		};
	}
	return { key, path, state: 'ok', message: 'Found, readable and writable.' };
}

function accessLog(path: string): PathCheck {
	const key = 'CADDY_LOG_PATH';
	const s = stat(path);
	if (!s) {
		return {
			key,
			path,
			state: 'warning',
			message:
				'Not found. Top paths, client IPs and exact error rates need Caddy’s JSON access log at this path.'
		};
	}
	if (!s.isFile()) return { key, path, state: 'error', message: 'This is not a file.' };
	if (!can(path, constants.R_OK))
		return { key, path, state: 'error', message: 'Found, but it cannot be read.' };
	return { key, path, state: 'ok', message: 'Found and readable.' };
}

function caddyData(path: string): PathCheck {
	const key = 'CADDY_DATA_PATH';
	const s = stat(path);
	if (!s) {
		return {
			key,
			path,
			state: 'warning',
			message: 'Not found. Certificate expiry dates come from Caddy’s data directory.'
		};
	}
	if (!s.isDirectory()) return { key, path, state: 'error', message: 'This is not a directory.' };
	if (!can(path, constants.R_OK | constants.X_OK)) {
		return { key, path, state: 'error', message: 'Found, but it cannot be read.' };
	}
	return { key, path, state: 'ok', message: 'Found and readable. Read-only is enough.' };
}

function uiData(path: string): PathCheck {
	const key = 'CADDY_UI_DATA';
	const s = stat(path);
	if (!s) return { key, path, state: 'error', message: 'Not found.' };
	if (!s.isDirectory()) return { key, path, state: 'error', message: 'This is not a directory.' };
	if (!can(path, constants.W_OK | constants.X_OK)) {
		return {
			key,
			path,
			state: 'error',
			message: 'Found, but not writable. The database and the Caddyfile backups live here.'
		};
	}
	return { key, path, state: 'ok', message: 'Found and writable.' };
}
