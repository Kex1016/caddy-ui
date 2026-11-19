import { describe, expect, it } from 'vitest';
import type { UpdatesView } from '$lib/api/updates';
import { channelNotice, intervalText } from './updates';

const view = (over: Partial<UpdatesView>): UpdatesView => ({
	state: 'ok',
	problem: null,
	dir: '/etc/caddy-ui/updater',
	version: '1.1.0',
	status: null,
	requestedInterval: null,
	checkPending: false,
	now: 0,
	...over
});

describe('intervalText', () => {
	it('writes seconds the way the interval is set', () => {
		expect(intervalText(3600)).toBe('1h');
		expect(intervalText(300)).toBe('5m');
		expect(intervalText(90)).toBe('1m 30s');
		expect(intervalText(86_400)).toBe('1d');
		expect(intervalText(0)).toBe('unknown');
	});
});

describe('channelNotice', () => {
	it('is silent while the updater reports', () => {
		expect(channelNotice(view({}))).toBeNull();
	});
	it('says what is wrong in each broken state', () => {
		expect(channelNotice(view({ state: 'no-channel', problem: '/x is not writable' }))?.text).toContain(
			'/x is not writable'
		);
		expect(channelNotice(view({ state: 'waiting' }))?.kind).toBe('neutral');
		expect(channelNotice(view({ state: 'stale' }))?.kind).toBe('warning');
	});
});
