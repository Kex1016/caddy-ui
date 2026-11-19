import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	channelProblem,
	readControl,
	readStatus,
	requestCheckNow,
	syncInterval,
	updatesView,
	writeControl
} from './channel';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'caddy-ui-channel-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse('2026-11-19T12:00:00Z');
const status = (over: Record<string, unknown> = {}) => ({
	version: 1,
	updatedAt: '2026-11-19T11:59:58Z',
	source: 'ghcr',
	pollSeconds: 5,
	checking: false,
	intervalSeconds: 3600,
	intervalFrom: 'env',
	nextCheckAt: '2026-11-19T12:30:00Z',
	checkNowHandled: null,
	warning: null,
	latest: { version: '1.1.0', id: 'sha256:abc' },
	lastRun: {
		startedAt: '2026-11-19T11:30:00Z',
		finishedAt: '2026-11-19T11:30:04Z',
		trigger: 'timer',
		result: 'up-to-date',
		message: 'ghcr.io/x is the newest image'
	},
	...over
});
const put = (name: string, body: unknown) =>
	writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));

describe('control.json', () => {
	it('is empty when missing or damaged', () => {
		expect(readControl(dir)).toMatchObject({ interval: null, checkNow: null });
		put('control.json', 'not json');
		expect(readControl(dir)).toMatchObject({ interval: null, checkNow: null });
	});

	it('keeps what a patch leaves out, and leaves no temporary file behind', () => {
		writeControl(dir, { interval: '5m' });
		requestCheckNow(dir);
		const c = readControl(dir);
		expect(c.interval).toBe('5m');
		expect(c.checkNow).toMatch(/^[0-9a-f]{16}$/);
		expect(readdirSync(dir)).toEqual(['control.json']);
		expect(JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')).version).toBe(1);
	});

	it('gives each check-now request a new token', () => {
		expect(requestCheckNow(dir)).not.toBe(requestCheckNow(dir));
	});

	it('syncs the saved interval only when it differs, and never creates a file just to say "nothing"', () => {
		expect(syncInterval(dir, null)).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
		expect(syncInterval(dir, '2h')).toBe(true);
		expect(syncInterval(dir, '2h')).toBe(false);
		requestCheckNow(dir);
		expect(syncInterval(dir, null)).toBe(true);
		expect(readControl(dir)).toMatchObject({ interval: null });
		expect(readControl(dir).checkNow).not.toBeNull();
	});
});

describe('status.json', () => {
	it('reads what the updater wrote', () => {
		put('status.json', status());
		const s = readStatus(dir);
		expect(s).toMatchObject({
			intervalSeconds: 3600,
			intervalFrom: 'env',
			latest: { version: '1.1.0' },
			lastRun: { result: 'up-to-date', trigger: 'timer' }
		});
	});

	it('is null for a missing, damaged or foreign file', () => {
		expect(readStatus(dir)).toBeNull();
		put('status.json', '{');
		expect(readStatus(dir)).toBeNull();
		put('status.json', { hello: 'world' });
		expect(readStatus(dir)).toBeNull();
	});

	it('drops a last run it does not understand rather than showing nonsense', () => {
		put('status.json', status({ lastRun: { result: 'exploded', startedAt: 'a', finishedAt: 'b' } }));
		expect(readStatus(dir)?.lastRun).toBeNull();
		put('status.json', status({ lastRun: { ...status().lastRun, trigger: 'telepathy' } }));
		expect(readStatus(dir)?.lastRun?.trigger).toBe('manual');
	});
});

describe('updatesView', () => {
	it('is ok while the updater writes', () => {
		put('status.json', status());
		const v = updatesView(dir, '1.1.0', NOW);
		expect(v).toMatchObject({ state: 'ok', checkPending: false, version: '1.1.0' });
	});

	it('is waiting before the updater has ever written', () => {
		expect(updatesView(dir, 'dev', NOW)).toMatchObject({ state: 'waiting', status: null });
	});

	it('is stale when the status is older than a few polls', () => {
		put('status.json', status({ updatedAt: '2026-11-19T11:50:00Z' }));
		expect(updatesView(dir, 'dev', NOW).state).toBe('stale');
	});

	it('shows a check as pending until the updater echoes its token', () => {
		put('status.json', status());
		const token = requestCheckNow(dir);
		expect(updatesView(dir, 'dev', NOW).checkPending).toBe(true);
		put('status.json', status({ checkNowHandled: token }));
		expect(updatesView(dir, 'dev', NOW).checkPending).toBe(false);
	});

	it('says when the directory cannot be written', () => {
		const blocked = join(dir, 'ro');
		mkdirSync(blocked);
		chmodSync(blocked, 0o500);
		// Root ignores directory modes; only assert where the mode is honoured.
		if (channelProblem(blocked) === null) return;
		expect(updatesView(blocked, 'dev', NOW)).toMatchObject({ state: 'no-channel' });
		chmodSync(blocked, 0o700);
	});

	it('treats a missing directory as writable when its parent is', () => {
		expect(channelProblem(join(dir, 'updater'))).toBeNull();
		expect(channelProblem(join(dir, 'a', 'b', 'c'))).toMatch(/cannot be created/);
	});
});
