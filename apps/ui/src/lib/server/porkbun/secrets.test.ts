import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as auditRoute } from '../../../routes/api/porkbun/audit/+server';
import { GET as statusRoute } from '../../../routes/api/porkbun/status/+server';
import { load as domainsLayout } from '../../../routes/domains/+layout.server';
import { load as domainLayout } from '../../../routes/domains/[domain]/+layout.server';
import { load as activityPage } from '../../../routes/domains/activity/+page.server';
import { PorkbunError } from './errors';
import {
	audit,
	auditLog,
	cached,
	listDomains,
	porkbun,
	porkbunStatus,
	requireDomain,
	toApiError,
	toResponse,
	write
} from './index';
import { fakeSeed, resetPorkbunForTests, useFakePorkbun, type FakeContext } from './testing';

// docs/porkbun-plan.md §3 and §5.1: the key values appear in no error, log line, audit row, cache row or
// response. This test drives the module through successes and failures with keys that are easy to spot,
// makes the far side echo them back in every place it could, and then searches everything that came out.

const KEY = 'pk1_SPOT_ME_public_c0ffee';
const SECRET = 'sk1_SPOT_ME_secret_decaf';

afterEach(() => {
	resetPorkbunForTests();
	vi.restoreAllMocks();
});

function setup(): FakeContext {
	return useFakePorkbun({ seed: { ...fakeSeed(), apiKey: KEY, apiSecret: SECRET } });
}

const event = (path: string, params: Record<string, string> = {}) =>
	({
		url: new URL(`http://localhost${path}`),
		params,
		locals: { identity: { user: 'david', via: 'open' } }
	}) as never;

/** Everything about an error that could be printed or sent. */
function dump(err: unknown): string {
	if (!(err instanceof Error)) return JSON.stringify(err);
	return [
		err.name,
		err.message,
		err.stack,
		JSON.stringify(err),
		JSON.stringify(toApiError(err)),
		String(err.cause ?? '')
	].join('\n');
}

describe('the API keys', () => {
	it('appear in no error, log line, audit row, cache row or response', async () => {
		const { fake, db } = setup();
		const out: string[] = [];
		for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation(
				(...args: unknown[]) => void out.push(args.map(String).join(' '))
			);
		}
		const keep = (value: unknown) => out.push(typeof value === 'string' ? value : JSON.stringify(value));
		const attempt = async (run: () => unknown) => {
			try {
				keep(await run());
			} catch (err) {
				out.push(dump(err));
			}
		};
		const echo = { apikey: KEY, secretapikey: SECRET, note: `you sent ${KEY} and ${SECRET}`, [SECRET]: KEY };

		// Ordinary traffic.
		await attempt(() => porkbunStatus());
		await attempt(() => listDomains());
		await attempt(() => cached('example.com:dns', () => porkbun().dns.list('example.com')));
		await attempt(() => requireDomain('example.com'));
		await attempt(() => requireDomain(KEY));
		await attempt(() => requireDomain(`${SECRET}.example.com`));

		// Porkbun refusing things, with and without echoing the request back.
		await attempt(() => porkbun().dns.list('example.org'));
		await attempt(() => porkbun().dns.get('example.com', KEY));
		await attempt(() =>
			porkbun().dns.create('example.com', { host: 'www', type: 'CNAME', content: 'example.org' })
		);
		fake.respondNext({
			status: 400,
			body: {
				status: 'ERROR',
				code: 'INVALID_API_KEYS_001',
				message: `Invalid API key ${KEY} / ${SECRET}`,
				...echo,
				next_action: { type: 'authenticate', hint: `check ${SECRET}`, url: `https://porkbun.com/?k=${KEY}` }
			}
		});
		await attempt(() => porkbun().ping());
		fake.respondNext({
			status: 200,
			body: {
				status: 'SUCCESS',
				records: [{ id: '1', name: 'example.com', type: 'TXT', content: `leak ${SECRET}`, notes: KEY }]
			}
		});
		await attempt(() => cached('example.com:leak', () => porkbun().dns.list('example.com')));
		fake.respondNext({ status: 502, text: `<html>upstream said ${KEY} ${SECRET}</html>` });
		await attempt(() => porkbun().ping());
		fake.respondNext({ status: 429, text: `${SECRET}`, headers: { 'retry-after': '99' } });
		await attempt(() => porkbun().ns.get('example.com'));
		fake.throwNext(
			new TypeError(`fetch failed for x-api-key ${KEY}`, { cause: { code: 'ECONNRESET', message: SECRET } })
		);
		await attempt(() => porkbun().ping());
		fake.throwNext(new TypeError('fetch failed', { cause: { code: SECRET } }));
		await attempt(() => porkbun().ping());

		// Writes through the helper: accepted, refused, refused with an echo, and with no answer.
		const base = {
			scope: 'dns' as const,
			author: 'david',
			domain: 'example.com',
			action: 'dns.create',
			request: { host: 'x', echo }
		};
		await attempt(() =>
			write({
				...base,
				run: (pb) => pb.dns.create('example.com', { host: 'x', type: 'A', content: '203.0.113.1' })
			})
		);
		await attempt(() =>
			write({
				...base,
				run: (pb) => pb.dns.create('example.com', { host: 'x', type: 'A', content: '203.0.113.1' })
			})
		);
		fake.respondNext({
			status: 400,
			body: { status: 'ERROR', code: 'INVALID_INPUT', message: `bad ${SECRET}`, ...echo }
		});
		await attempt(() => write({ ...base, before: echo, run: (pb) => pb.dns.delete('example.com', '1') }));
		fake.throwNext(new Error(`socket closed while sending ${SECRET}`));
		await attempt(() => write({ ...base, run: (pb) => pb.dns.delete('example.com', '1') }));
		await attempt(() =>
			audit({
				author: KEY,
				domain: 'example.com',
				action: 'test',
				request: echo,
				before: [SECRET],
				ok: false,
				result: { error: `${KEY}` }
			})
		);

		// The writes dropped the domain's cached rows; leave one behind that Porkbun "leaked" a key into.
		fake.respondNext({ status: 200, body: { status: 'SUCCESS', ns: [`ns1.${SECRET}.example`, KEY] } });
		await attempt(() => cached('example.com:ns', () => porkbun().ns.get('example.com')));

		// What routes and pages hand to the browser.
		for (const err of [
			new PorkbunError({ code: 'X', message: 'plain', httpStatus: 400 }),
			await porkbun()
				.dns.list('example.org')
				.catch((e: unknown) => e)
		]) {
			const res = toResponse(err);
			keep(await res.text());
			keep([...res.headers].join());
		}
		for (const res of [
			await statusRoute(event('/api/porkbun/status?force')),
			await auditRoute(event('/api/porkbun/audit')),
			await auditRoute(event('/api/porkbun/audit?domain=example.com&limit=2'))
		]) {
			keep(await res.text());
			keep([...res.headers].join());
		}
		await attempt(() => domainsLayout(event('/domains')));
		await attempt(() => domainLayout(event('/domains/example.com', { domain: 'example.com' })));
		await attempt(() => domainLayout(event(`/domains/${KEY}`, { domain: KEY })));
		await attempt(() => activityPage(event('/domains/activity')));
		keep(auditLog());

		// Everything at rest.
		keep(db.prepare('SELECT * FROM porkbun_audit').all());
		keep(db.prepare('SELECT * FROM porkbun_cache').all());
		keep(db.prepare('SELECT * FROM settings').all());

		const everything = out.join('\n');
		// The test did what it meant to: rows were written, failures happened, and the echo was seen and blanked.
		expect(db.prepare('SELECT count(*) AS n FROM porkbun_audit').get()).toEqual({ n: 5 });
		expect(db.prepare('SELECT count(*) AS n FROM porkbun_cache').get()).toEqual({ n: 2 });
		expect(everything).toContain('[redacted]');
		expect(everything).toContain('INVALID_API_KEYS_001');
		expect(everything).toContain('ECONNRESET');
		expect(fake.requests.length).toBeGreaterThan(15);

		expect(everything).not.toContain(KEY);
		expect(everything).not.toContain(SECRET);
		expect(everything).not.toContain('SPOT_ME');
	});

	it('are sent to Porkbun only, as headers, and only on calls that need them', async () => {
		const { fake } = setup();
		await porkbunStatus();
		await porkbun().pricing.get(['com']);
		await porkbun().dns.create('example.com', { host: 'x', type: 'A', content: '203.0.113.1' });
		for (const req of fake.requests) {
			const outsideHeaders = JSON.stringify([req.rawPath, req.query, req.body ?? null]);
			expect(outsideHeaders).not.toContain('SPOT_ME');
			if (req.path === 'pricing/get') expect(JSON.stringify(req.headers)).not.toContain('SPOT_ME');
			else expect(req.headers['x-secret-api-key']).toBe(SECRET);
		}
	});
});
