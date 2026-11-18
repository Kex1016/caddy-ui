import { createDirective, parse, print, type Directive, type SiteBlock } from '@caddy-ui/caddyfile';
import { describe, expect, it } from 'vitest';
import { PORKBUN_PLUGIN_MODULE } from '$lib/api/porkbun-caddy';
import { addPorkbunChallenge, choosePorkbun } from '$lib/visual/forms/directives/dns-provider';
import { AdminUnreachableError, CaddyAdmin } from '../admin';
import { PluginDetector, PROBE_CADDYFILE } from './plugin';

/**
 * docs/porkbun-plan.md §5.1 P5 against a real Caddy: with the plugin Caddy a wildcard site with the Porkbun
 * block adapts cleanly through the forms; with stock Caddy the UI says the plugin is missing.
 *
 * Run with `pnpm --filter @caddy-ui/ui test:caddy`, CADDY_TEST_ADMIN_URL pointing at a Caddy admin API, and
 * CADDY_TEST_PORKBUN_PLUGIN=present when that Caddy is built from deploy/caddy/Dockerfile. Without it the
 * Caddy is taken to be a stock one. Nothing is loaded into Caddy: every call is `POST /adapt`.
 */
const adminUrl = process.env.CADDY_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('Set CADDY_TEST_ADMIN_URL to a Caddy admin API, e.g. http://127.0.0.1:2019');
const expected = process.env.CADDY_TEST_PORKBUN_PLUGIN === 'present' ? 'present' : 'missing';

const caddy = new CaddyAdmin(adminUrl);

/**
 * Other test files reload this Caddy while these run, and a request can land on an admin endpoint that is
 * being replaced. So a call that could not connect is tried again; an answer from Caddy never is.
 */
async function patient<T>(run: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (err) {
			if (!(err instanceof AdminUnreachableError) || attempt === 5) throw err;
			await new Promise((r) => setTimeout(r, 300 * attempt));
		}
	}
}
const admin = {
	adapt: (text: string) => patient(() => caddy.adapt(text)),
	metrics: () => patient(() => caddy.metrics()),
	getConfig: () => patient(() => caddy.getConfig())
};

/** A wildcard site as the Sites page's "use the Porkbun DNS challenge" action leaves it. */
function wildcardSite(): string {
	const { file: doc } = parse('*.example.com {\n\treverse_proxy 10.0.0.5:8080\n}\n');
	const site = doc.blocks.find((n): n is SiteBlock => n.kind === 'site');
	if (!site) throw new Error('no site in the fixture');
	expect(addPorkbunChallenge(site)).toBe(true);
	return print(doc);
}

/** The global option as the `acme_dns` form leaves it when Porkbun is chosen. */
function globalOption(): string {
	const node: Directive = createDirective('acme_dns', []);
	choosePorkbun(node);
	const { file: doc } = parse('{\n}\n\napp.example.com {\n\trespond "ok"\n}\n');
	const global = doc.blocks.find((n) => n.kind === 'global');
	if (!global || global.kind !== 'global') throw new Error('no global block in the fixture');
	global.body.push(node);
	return print(doc);
}

describe(`Porkbun plugin detection against a real Caddy (plugin ${expected})`, () => {
	it('says what the running Caddy was built with', async () => {
		const check = await new PluginDetector(admin).check();
		expect(check.reason).toBeUndefined();
		expect(check).toMatchObject({ module: PORKBUN_PLUGIN_MODULE, state: expected });
	});

	it('the probe changes nothing in Caddy', async () => {
		const before = JSON.stringify(await admin.getConfig());
		await new PluginDetector(admin).check({ force: true });
		expect(JSON.stringify(await admin.getConfig())).toBe(before);
	});

	it('what the forms write keeps the keys in the environment', () => {
		for (const text of [wildcardSite(), globalOption()]) {
			expect(text).toContain('api_key {env.PORKBUN_API_KEY}');
			expect(text).toContain('api_secret_key {env.PORKBUN_API_SECRET_KEY}');
		}
		expect(wildcardSite()).toMatch(/\*\.example\.com \{\n\ttls \{\n\t\tdns porkbun \{/);
	});
});

describe.runIf(expected === 'present')('with the plugin Caddy', () => {
	it('a wildcard site with the Porkbun block adapts cleanly through the forms', async () => {
		const result = await admin.adapt(wildcardSite());
		expect(result.ok ? [] : result.diagnostics).toEqual([]);
		if (!result.ok) return;
		// No warning either: what the forms write is already in `caddy fmt` shape.
		expect(result.diagnostics).toEqual([]);
		const json = JSON.stringify(result.config);
		expect(json).toContain('"name":"porkbun"');
		// The placeholders stay placeholders: Caddy fills them in from its own environment when it runs.
		expect(json).toContain('{env.PORKBUN_API_KEY}');
		expect(json).toContain('{env.PORKBUN_API_SECRET_KEY}');
	});

	it('so does the global acme_dns option, and the probe itself', async () => {
		for (const text of [globalOption(), PROBE_CADDYFILE]) {
			const result = await admin.adapt(text);
			expect(result.ok ? [] : result.diagnostics).toEqual([]);
		}
	});
});

describe.runIf(expected === 'missing')('with stock Caddy', () => {
	it('the same Caddyfile is refused, naming the module', async () => {
		const result = await admin.adapt(wildcardSite());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((d) => d.message).join('\n')).toContain(
			`module not registered: ${PORKBUN_PLUGIN_MODULE}`
		);
	});
});
