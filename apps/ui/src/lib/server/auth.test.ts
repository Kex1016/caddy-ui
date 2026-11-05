import { describe, expect, it } from 'vitest';
import { LoginLimiter, checkCredentials, effectiveAuth, identify, safeRedirect } from './auth';
import { encodeSession, makeSecret } from './session';

const secret = makeSecret('s');

describe('effectiveAuth', () => {
	it('uses local sign-in when both credentials are set', () => {
		expect(effectiveAuth({ authMode: 'local', user: 'a', password: 'b' })).toEqual({
			mode: 'local',
			user: 'a',
			password: 'b'
		});
	});
	it('turns local sign-in off when both are unset', () => {
		expect(effectiveAuth({ authMode: 'local', user: undefined, password: undefined }).mode).toBe(
			'local-disabled'
		);
	});
	it('fails closed when only one is set', () => {
		expect(effectiveAuth({ authMode: 'local', user: 'a', password: undefined })).toEqual({
			mode: 'local-misconfigured',
			missing: 'CADDY_UI_PASSWORD'
		});
		expect(effectiveAuth({ authMode: 'local', user: undefined, password: 'b' })).toEqual({
			mode: 'local-misconfigured',
			missing: 'CADDY_UI_USER'
		});
	});
	it('ignores credentials in forward and none modes', () => {
		expect(effectiveAuth({ authMode: 'forward', user: 'a', password: 'b' }).mode).toBe('forward');
		expect(effectiveAuth({ authMode: 'none', user: 'a', password: 'b' }).mode).toBe('none');
	});
});

describe('identify', () => {
	const local = { mode: 'local', user: 'david', password: 'pw' } as const;
	const none = new Headers();

	it('accepts a valid session for the configured user', () => {
		const token = encodeSession(secret, { user: 'david', exp: 2000 });
		expect(identify(local, secret, token, none, 1000)).toEqual({ user: 'david', via: 'session' });
	});
	it('rejects a session for a user that is no longer configured', () => {
		const token = encodeSession(secret, { user: 'old', exp: 2000 });
		expect(identify(local, secret, token, none, 1000)).toBeNull();
	});
	it('rejects a missing session', () => {
		expect(identify(local, secret, undefined, none)).toBeNull();
	});
	it('does not trust Remote-User in local mode', () => {
		expect(identify(local, secret, undefined, new Headers({ 'remote-user': 'david' }))).toBeNull();
	});
	it('reads Remote-User in forward mode', () => {
		expect(
			identify({ mode: 'forward' }, secret, undefined, new Headers({ 'Remote-User': ' david ' }))
		).toEqual({ user: 'david', via: 'forward' });
		expect(identify({ mode: 'forward' }, secret, undefined, new Headers({ 'remote-user': '' }))).toBeNull();
		expect(identify({ mode: 'forward' }, secret, undefined, none)).toBeNull();
	});
	it('lets everyone in with none or local sign-in off', () => {
		expect(identify({ mode: 'none' }, secret, undefined, none)?.via).toBe('open');
		expect(identify({ mode: 'local-disabled' }, secret, undefined, none)?.via).toBe('open');
	});
	it('refuses everyone with a broken local config', () => {
		expect(identify({ mode: 'local-misconfigured', missing: 'CADDY_UI_USER' }, secret, 'x', none)).toBeNull();
	});
});

describe('checkCredentials', () => {
	const auth = { mode: 'local', user: 'david', password: 'correct horse' } as const;
	it('accepts the right pair only', () => {
		expect(checkCredentials(auth, 'david', 'correct horse')).toBe(true);
		expect(checkCredentials(auth, 'david', 'wrong')).toBe(false);
		expect(checkCredentials(auth, 'other', 'correct horse')).toBe(false);
		expect(checkCredentials(auth, '', '')).toBe(false);
	});
});

describe('LoginLimiter', () => {
	it('blocks after max failures and unblocks when the window passes', () => {
		const limiter = new LoginLimiter(3, 1000);
		limiter.fail('ip', 0);
		limiter.fail('ip', 100);
		expect(limiter.retryAfter('ip', 200)).toBe(0);
		limiter.fail('ip', 200);
		expect(limiter.retryAfter('ip', 300)).toBe(700);
		expect(limiter.retryAfter('other', 300)).toBe(0);
		expect(limiter.retryAfter('ip', 1000)).toBe(0);
	});
	it('clears on success', () => {
		const limiter = new LoginLimiter(1, 1000);
		limiter.fail('ip', 0);
		expect(limiter.retryAfter('ip', 1)).toBeGreaterThan(0);
		limiter.succeed('ip');
		expect(limiter.retryAfter('ip', 1)).toBe(0);
	});
});

describe('safeRedirect', () => {
	it.each([
		['/sites', '/sites'],
		['/sites?x=1', '/sites?x=1'],
		[null, '/'],
		['', '/'],
		['https://evil.example', '/'],
		['//evil.example', '/'],
		['/\\evil.example', '/'],
		['sites', '/']
	])('%j → %j', (input, out) => {
		expect(safeRedirect(input)).toBe(out);
	});
});
