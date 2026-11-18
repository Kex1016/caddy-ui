import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db';
import { insertAudit, listAudit, type AuditInput } from './audit';
import { redactor } from './errors';

let db: Db;
const plain = (text: string) => text;

beforeEach(() => {
	db = openDb(':memory:');
});

const entry = (over: Partial<AuditInput> = {}): AuditInput => ({
	author: 'david',
	domain: 'example.com',
	action: 'dns.create',
	request: { host: 'www', type: 'A', content: '203.0.113.10' },
	ok: true,
	result: { id: '1', warnings: [] },
	...over
});

describe('audit log', () => {
	it('stores a row and reads it back, newest first', () => {
		const a = insertAudit(db, entry({ before: { content: '203.0.113.9' }, requestId: 'req-1' }), plain, 1000);
		const b = insertAudit(
			db,
			entry({ action: 'dns.delete', ok: false, result: { error: { code: 'INVALID_RECORD_ID' } } }),
			plain,
			2000
		);
		expect(b).toBeGreaterThan(a);
		expect(listAudit(db)).toEqual({
			entries: [
				{
					id: b,
					ts: 2000,
					author: 'david',
					domain: 'example.com',
					action: 'dns.delete',
					request: { host: 'www', type: 'A', content: '203.0.113.10' },
					before: null,
					ok: false,
					result: { error: { code: 'INVALID_RECORD_ID' } },
					requestId: null
				},
				{
					id: a,
					ts: 1000,
					author: 'david',
					domain: 'example.com',
					action: 'dns.create',
					request: { host: 'www', type: 'A', content: '203.0.113.10' },
					before: { content: '203.0.113.9' },
					ok: true,
					result: { id: '1', warnings: [] },
					requestId: 'req-1'
				}
			],
			nextBefore: null
		});
	});

	it('filters by domain, case-insensitively, and pages with before', () => {
		for (let i = 0; i < 5; i++)
			insertAudit(db, entry({ domain: i % 2 ? 'Example.NET' : 'example.com' }), plain, i);
		expect(listAudit(db, { domain: 'EXAMPLE.net' }).entries.map((e) => e.domain)).toEqual([
			'example.net',
			'example.net'
		]);
		const first = listAudit(db, { limit: 2 });
		expect(first.entries.map((e) => e.id)).toEqual([5, 4]);
		expect(first.nextBefore).toBe(4);
		const second = listAudit(db, { limit: 2, before: first.nextBefore! });
		expect(second.entries.map((e) => e.id)).toEqual([3, 2]);
		expect(listAudit(db, { limit: 2, before: second.nextBefore! })).toMatchObject({ nextBefore: null });
	});

	it('blanks key values wherever they appear and fields named like a secret whatever they hold', () => {
		const redact = redactor(['pk1_live_key', 'sk1_live_secret']);
		insertAudit(
			db,
			entry({
				author: 'pk1_live_key',
				request: {
					note: 'sent with pk1_live_key',
					nested: [{ sk1_live_secret: 'as a key' }],
					apikey: 'other',
					secretapikey: 'x'
				},
				before: { privatekey: 'PEM', privateKey: 'PEM', private_key: 'PEM', Authorization: 'Bearer t' },
				result: { echoed: 'sk1_live_secret' }
			}),
			redact,
			1
		);
		const raw = JSON.stringify(db.prepare('SELECT * FROM porkbun_audit').all());
		expect(raw).not.toMatch(/pk1_live_key|sk1_live_secret|PEM|Bearer|other/);
		expect(listAudit(db).entries[0]).toMatchObject({
			author: '[redacted]',
			request: {
				note: 'sent with [redacted]',
				nested: [{ '[redacted]': 'as a key' }],
				apikey: '[redacted]',
				secretapikey: '[redacted]'
			},
			before: {
				privatekey: '[redacted]',
				privateKey: '[redacted]',
				private_key: '[redacted]',
				Authorization: '[redacted]'
			},
			result: { echoed: '[redacted]' }
		});
	});
});
