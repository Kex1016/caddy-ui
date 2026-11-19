import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import type {
	CaddyTieIn,
	ChallengeCleanupPreview,
	ChallengeCleanupResult,
	RecordFix,
	RecordFixPreview,
	RecordFixResult
} from '$lib/api/porkbun-caddy';
import { STALE_AFTER_MS } from '$lib/server/caddy/porkbun/challenges';
import { caddyTieIn } from '$lib/server/caddy/porkbun/check';
import { useTieIn, type TieInContext } from '$lib/server/caddy/porkbun/testing';
import { auditLog } from '$lib/server/porkbun';
import { resetPorkbunForTests, useFakePorkbun, type FakeContext } from '$lib/server/porkbun/testing';
import { GET } from './+server';
import { POST as challenges } from './challenges/+server';
import { POST as records } from './records/+server';

const CADDYFILE = `example.com {
	respond "apex"
}

mail.example.com, new.example.com {
	respond "two"
}

app.example.dev {
	respond "dev"
}
`;

let pb: FakeContext;
let tie: TieInContext;

async function arrange(settings: Parameters<typeof useFakePorkbun>[0] = {}, plugin = true): Promise<void> {
	pb = useFakePorkbun(settings);
	tie = await useTieIn(CADDYFILE, { plugin });
	// No wildcard record, so `new.example.com` has no answer.
	pb.fake.setRecords(
		'example.com',
		pb.fake
			.records('example.com')
			.filter((r) => r.host !== '*')
			.map((r) => ({ name: r.host, type: r.type, content: r.content }))
	);
}

afterEach(async () => {
	await tie?.cleanup();
	resetPorkbunForTests();
});

const locals = { identity: { user: 'david', via: 'open' } };

/** What SvelteKit does with an `error(…)` thrown by a `+server.ts`: its body as JSON with its status. */
async function answer(run: () => Response | Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (err) {
		if (!isHttpError(err)) throw err;
		return Response.json(err.body, { status: err.status });
	}
}
const get = (query = '') =>
	answer(() => GET({ url: new URL(`http://localhost/api/porkbun/caddy${query}`), locals } as never));
const post = (handler: typeof records | typeof challenges, body: unknown) =>
	answer(() =>
		handler({
			request: new Request('http://localhost/x', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: typeof body === 'string' ? body : JSON.stringify(body)
			}),
			locals
		} as never)
	);

const writes = () => pb.fake.requests.filter((r) => /^dns\/(create|edit|delete)/.test(r.path));
const real = () => writes().filter((r) => (r.body as { dryRun?: boolean } | undefined)?.dryRun !== true);

describe('GET /api/porkbun/caddy', () => {
	it('answers the tie-in, uncached by the browser', async () => {
		await arrange();
		const res = await get();
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = (await res.json()) as CaddyTieIn;
		expect(body.plugin).toMatchObject({ module: 'dns.providers.porkbun', state: 'present' });
		expect(body.sites.map((s) => [s.host, s.status])).toEqual([
			['example.com', 'ok'],
			['mail.example.com', 'wrong'],
			['new.example.com', 'missing'],
			['app.example.dev', 'not_porkbun']
		]);
		// What the DNS tab reads from it: the records each site resolves through, by id.
		expect(body.sites[0]?.records[0]?.id).toMatch(/^\d+$/);
		expect(typeof body.sites[0]?.dns01).toBe('boolean');
	});

	it('?only=plugin asks Caddy and never Porkbun, so it works with the keys unset', async () => {
		await arrange({ settings: { apiKey: undefined, apiSecret: undefined } }, false);
		const res = await get('?only=plugin');
		expect(res.status).toBe(200);
		const body = (await res.json()) as CaddyTieIn;
		expect(Object.keys(body)).toEqual(['plugin']);
		expect(body.plugin.state).toBe('missing');
		expect(pb.fake.requests).toHaveLength(0);
	});

	it('answers a 200 without sites when the keys are unset', async () => {
		await arrange({ settings: { apiKey: undefined, apiSecret: undefined } });
		const res = await get();
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ porkbun: 'off', sites: [], plugin: { state: 'present' } });
	});

	it('?domain= narrows to one domain and refuses one that is not in the account', async () => {
		await arrange();
		const body = (await (await get('?domain=example.com')).json()) as CaddyTieIn;
		expect(body.sites.map((s) => s.host)).toEqual(['example.com', 'mail.example.com', 'new.example.com']);
		expect(body.domains.map((d) => d.domain)).toEqual(['example.com']);
		const res = await get('?domain=example.dev');
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: 'DOMAIN_NOT_IN_ACCOUNT' });
	});

	it('never carries a key', async () => {
		await arrange();
		const text = await (await get()).text();
		expect(text).not.toContain(pb.fake.credentials.apiKey);
		expect(text).not.toContain(pb.fake.credentials.apiSecret);
	});
});

describe('POST /api/porkbun/caddy/records', () => {
	it('rehearses the change without changing anything', async () => {
		await arrange();
		const res = await post(records, { host: 'new.example.com', dryRun: true });
		expect(res.status).toBe(200);
		const body = (await res.json()) as RecordFixPreview;
		expect(body.fix).toEqual({
			kind: 'create',
			domain: 'example.com',
			host: 'new',
			type: 'A',
			content: '203.0.113.10'
		});
		expect(body.dryRun).toBeDefined();
		expect(real()).toHaveLength(0);
		expect(pb.fake.records('example.com').some((r) => r.host === 'new')).toBe(false);
		expect(auditLog().entries).toHaveLength(0);
	});

	it("creates the missing record with this server's IP, and logs it", async () => {
		await arrange();
		const preview = (await (
			await post(records, { host: 'new.example.com', dryRun: true })
		).json()) as RecordFixPreview;
		const res = await post(records, { host: 'new.example.com', expect: preview.fix });
		expect(res.status).toBe(200);
		const body = (await res.json()) as RecordFixResult;
		expect(body.result.ok).toBe(true);
		const made = pb.fake.records('example.com').find((r) => r.host === 'new');
		expect(made).toMatchObject({ type: 'A', content: '203.0.113.10' });
		expect(made?.notes).toContain('new.example.com');

		const log = auditLog().entries;
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ author: 'david', domain: 'example.com', action: 'dns.create', ok: true });

		// The cache was dropped by the write: the next check sees the record.
		const after = (await (await get()).json()) as CaddyTieIn;
		expect(after.sites.find((s) => s.host === 'new.example.com')).toMatchObject({ status: 'ok', fix: null });
	});

	it('changes the one record that points elsewhere, keeping what it was in the log', async () => {
		await arrange();
		const res = await post(records, { host: 'mail.example.com' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as RecordFixResult;
		expect(body.fix).toMatchObject({ kind: 'edit', before: '203.0.113.25', content: '203.0.113.10' });
		expect(pb.fake.records('example.com').find((r) => r.host === 'mail' && r.type === 'A')?.content).toBe(
			'203.0.113.10'
		);
		const entry = auditLog().entries[0];
		expect(entry).toMatchObject({ action: 'dns.edit', ok: true });
		expect(JSON.stringify(entry)).toContain('203.0.113.25');
	});

	it('takes the record content from the server, whatever the browser sends', async () => {
		await arrange();
		const res = await post(records, { host: 'new.example.com', content: '198.51.100.66', type: 'TXT' });
		expect(res.status).toBe(200);
		expect(pb.fake.records('example.com').find((r) => r.host === 'new')).toMatchObject({
			type: 'A',
			content: '203.0.113.10'
		});
	});

	it('refuses with the new fix when the records changed since the review', async () => {
		await arrange();
		const reviewed: RecordFix = {
			kind: 'edit',
			domain: 'example.com',
			host: 'mail',
			type: 'A',
			content: '203.0.113.10',
			id: '1',
			before: '198.51.100.1'
		};
		const res = await post(records, { host: 'mail.example.com', expect: reviewed });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string; fix: RecordFix };
		expect(body.code).toBe('RECORDS_CHANGED');
		expect(body.fix.before).toBe('203.0.113.25');
		expect(real()).toHaveLength(0);
	});

	it('sees a change made at Porkbun since the last read', async () => {
		await arrange();
		await get();
		// Someone fixes it at Porkbun's own site; the cached zone still says "wrong".
		pb.fake.setRecords('example.com', [{ name: 'mail', type: 'A', content: '203.0.113.10' }]);
		const res = await post(records, { host: 'mail.example.com' });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: 'NOTHING_TO_FIX' });
	});

	it('refuses what is not a site, not in the account, or already right', async () => {
		await arrange();
		const cases: [unknown, number, string][] = [
			[{ host: 'example.com' }, 409, 'NOTHING_TO_FIX'],
			[{ host: 'nosuch.example.com' }, 404, 'SITE_NOT_FOUND'],
			[{ host: 'app.example.dev' }, 404, 'DOMAIN_NOT_IN_ACCOUNT'],
			[{ host: 'not a host' }, 400, 'BAD_REQUEST'],
			[{ host: 'new.example.com', expect: { kind: 'delete' } }, 400, 'BAD_REQUEST'],
			[['new.example.com'], 400, 'BAD_REQUEST'],
			['not json', 400, 'BAD_REQUEST']
		];
		for (const [body, status, code] of cases) {
			const res = await post(records, body);
			expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([status, code]);
		}
		expect(writes()).toHaveLength(0);
	});

	it('is refused in read-only mode, dry run included', async () => {
		await arrange({ settings: { readonly: true } });
		for (const dryRun of [true, false]) {
			const res = await post(records, { host: 'new.example.com', dryRun });
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ code: 'READ_ONLY' });
		}
		expect(writes()).toHaveLength(0);
	});

	it('answers 502 with the refusal when Porkbun refuses the write, and logs it', async () => {
		await arrange();
		pb.fake.recordLimit = pb.fake.records('example.com').length;
		const res = await post(records, { host: 'new.example.com' });
		expect(res.status).toBe(502);
		const body = (await res.json()) as RecordFixResult;
		expect(body.result).toMatchObject({ ok: false, error: { code: 'ZONE_RECORD_LIMIT' } });
		expect(pb.fake.records('example.com').some((r) => r.host === 'new')).toBe(false);
		expect(auditLog().entries[0]).toMatchObject({ action: 'dns.create', ok: false });
	});
});

describe('POST /api/porkbun/caddy/challenges', () => {
	const seen = async (ago: number) => {
		const t = await caddyTieIn({ now: Date.now() - ago });
		return t.challenges[0]?.id as string;
	};

	it('deletes a record left behind for more than a day, and logs what it held', async () => {
		await arrange();
		const id = await seen(STALE_AFTER_MS + 60_000);
		const res = await post(challenges, { domain: 'example.com', ids: [id] });
		expect(res.status).toBe(200);
		const body = (await res.json()) as ChallengeCleanupResult;
		expect(body.results).toHaveLength(1);
		expect(body.results[0]).toMatchObject({ id, name: '_acme-challenge.example.com', result: { ok: true } });
		expect(pb.fake.records('example.com').some((r) => r.host === '_acme-challenge')).toBe(false);
		const entry = auditLog().entries[0];
		expect(entry).toMatchObject({ action: 'dns.delete', author: 'david', ok: true });
		expect(JSON.stringify(entry)).toContain('fake-acme-challenge-token');
	});

	it('rehearses the cleanup without deleting anything', async () => {
		await arrange();
		const id = await seen(STALE_AFTER_MS + 60_000);
		const res = await post(challenges, { domain: 'example.com', ids: [id], dryRun: true });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ dryRun: { wouldSucceed: true, warnings: [] } });
		expect(pb.fake.records('example.com').some((r) => r.host === '_acme-challenge')).toBe(true);
		expect(real()).toHaveLength(0);
		expect(auditLog().entries).toHaveLength(0);

		// A record that may still be in use fails the rehearsal as it would fail the cleanup.
		resetPorkbunForTests();
		pb = useFakePorkbun();
		const fresh = await seen(60_000);
		const body = (await (
			await post(challenges, { domain: 'example.com', ids: [fresh], dryRun: true })
		).json()) as ChallengeCleanupPreview;
		expect(body.dryRun).toMatchObject({ wouldSucceed: false, error: { code: 'CHALLENGE_IN_USE' } });
	});

	it('leaves a record alone that a certificate order may still need', async () => {
		await arrange();
		const id = await seen(60_000);
		const body = (await (
			await post(challenges, { domain: 'example.com', ids: [id] })
		).json()) as ChallengeCleanupResult;
		expect(body.results[0]?.result).toMatchObject({ ok: false, error: { code: 'CHALLENGE_IN_USE' } });
		expect(pb.fake.records('example.com').some((r) => r.host === '_acme-challenge')).toBe(true);
		expect(real()).toHaveLength(0);
	});

	it('never deletes anything that is not a challenge record, and goes on with the rest', async () => {
		await arrange();
		const id = await seen(STALE_AFTER_MS + 60_000);
		const apex = pb.fake.records('example.com').find((r) => r.host === '' && r.type === 'A')?.id as string;
		const body = (await (
			await post(challenges, { domain: 'example.com', ids: [apex, id, id] })
		).json()) as ChallengeCleanupResult;
		expect(body.results.map((r) => [r.id, r.result.ok])).toEqual([
			[apex, false],
			[id, true]
		]);
		expect(body.results[0]?.result).toMatchObject({ error: { code: 'NOT_A_CHALLENGE' } });
		expect(pb.fake.records('example.com').some((r) => r.id === apex)).toBe(true);
	});

	it('refuses bad requests, other domains and read-only mode', async () => {
		await arrange();
		for (const body of [
			{},
			{ domain: 'example.com' },
			{ domain: 'example.com', ids: [] },
			{ domain: 'example.com', ids: ['../1'] }
		]) {
			expect((await post(challenges, body)).status).toBe(400);
		}
		expect((await post(challenges, { domain: 'example.dev', ids: ['1'] })).status).toBe(404);
		resetPorkbunForTests();
		pb = useFakePorkbun({ settings: { readonly: true } });
		const res = await post(challenges, { domain: 'example.com', ids: ['1'] });
		expect(res.status).toBe(403);
		expect(real()).toHaveLength(0);
	});
});

/** docs/porkbun-plan.md §5.1: every Caddy call of the tie-in goes through `adminFetch`. */
describe('the tie-in never calls fetch itself', () => {
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const folders = [
		'lib/server/caddy/porkbun',
		'routes/api/porkbun/caddy',
		'routes/domains/[domain]/caddy',
		'routes/sites'
	];
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? files(path) : [path];
		});

	it('in any server file: Caddy is reached through CaddyAdmin (adminFetch), Porkbun through the client', () => {
		const server = folders
			.flatMap((f) => files(join(root, f)))
			.filter((f) => /\.ts$/.test(f) && !/\.(test|caddy-test)\.ts$/.test(f))
			.filter(
				(f) =>
					f.includes('/lib/server/') ||
					/\+(page\.server|layout\.server|server)\.ts$/.test(f) ||
					f.endsWith('respond.ts')
			);
		expect(server.length).toBeGreaterThan(8);
		for (const file of server) {
			const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
			expect(code, file).not.toMatch(/(?<![.\w])fetch\s*\(/);
			expect(code, file).not.toMatch(/\b(globalThis|window)\.fetch\b/);
			expect(code, file).not.toMatch(/from 'node:https?'|undici/);
		}
	});

	it('and the detector is built on CaddyAdmin', () => {
		const plugin = readFileSync(join(root, 'lib/server/caddy/porkbun/plugin.ts'), 'utf8');
		expect(plugin).toMatch(/new CaddyAdmin\(/);
		const admin = readFileSync(join(root, 'lib/server/caddy/admin.ts'), 'utf8');
		expect(admin).toMatch(/adminFetch/);
	});
});
