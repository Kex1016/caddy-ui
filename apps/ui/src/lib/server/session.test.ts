import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeSession, encodeSession, makeSecret } from './session';

const secret = makeSecret('test-secret');

describe('sessions', () => {
	it('round-trips', () => {
		const token = encodeSession(secret, { user: 'david', exp: 2000 });
		expect(decodeSession(secret, token, 1000)).toEqual({ user: 'david', exp: 2000 });
	});

	it('rejects expired sessions', () => {
		const token = encodeSession(secret, { user: 'david', exp: 2000 });
		expect(decodeSession(secret, token, 2000)).toBeNull();
	});

	it('rejects a token signed with another secret', () => {
		const token = encodeSession(makeSecret('other'), { user: 'david', exp: 2000 });
		expect(decodeSession(secret, token, 1000)).toBeNull();
	});

	it('rejects a tampered body', () => {
		const token = encodeSession(secret, { user: 'david', exp: 2000 });
		const [, mac] = token.split('.');
		const forged = Buffer.from(JSON.stringify({ user: 'admin', exp: 2000 })).toString('base64url');
		expect(decodeSession(secret, `${forged}.${mac}`, 1000)).toBeNull();
	});

	it.each([undefined, '', 'abc', 'a.b.c', '.x', 'eyJ9.'])('rejects malformed token %j', (token) => {
		expect(decodeSession(secret, token, 1000)).toBeNull();
	});

	it('rejects a validly signed body of the wrong shape', () => {
		const body = Buffer.from(JSON.stringify({ user: 1, exp: 'never' })).toString('base64url');
		const mac = createHmac('sha256', secret).update(body).digest('base64url');
		expect(decodeSession(secret, `${body}.${mac}`, 0)).toBeNull();
	});

	it('generates a random secret when none is configured', () => {
		expect(makeSecret(undefined).equals(makeSecret(undefined))).toBe(false);
		expect(makeSecret(undefined)).toHaveLength(32);
	});
});
