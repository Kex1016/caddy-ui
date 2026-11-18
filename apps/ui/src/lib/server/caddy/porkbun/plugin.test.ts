import { describe, expect, it } from 'vitest';
import { AdminUnreachableError } from '../admin';
import { PluginDetector, PROBE_CADDYFILE } from './plugin';
import { PluginAdmin } from './testing';

describe('Porkbun plugin detection', () => {
	it('adapts a Caddyfile that uses acme_dns porkbun with placeholders only', () => {
		expect(PROBE_CADDYFILE).toContain('acme_dns porkbun {');
		expect(PROBE_CADDYFILE).toContain('api_key {env.PORKBUN_API_KEY}');
		expect(PROBE_CADDYFILE).toContain('api_secret_key {env.PORKBUN_API_SECRET_KEY}');
		// No site block: adapting it could not describe anything Caddy would serve.
		expect(PROBE_CADDYFILE.split('\n').filter((l) => /^\S/.test(l))).toEqual(['{', '}']);
	});

	it('says present when Caddy adapts it, and missing on "module not registered"', async () => {
		const admin = new PluginAdmin();
		expect(await new PluginDetector(admin).check()).toMatchObject({
			module: 'dns.providers.porkbun',
			state: 'present'
		});
		admin.hasPlugin = false;
		const missing = await new PluginDetector(admin).check();
		expect(missing.state).toBe('missing');
		expect(missing.reason).toBeUndefined();
		expect(admin.adapts).toEqual([PROBE_CADDYFILE, PROBE_CADDYFILE]);
	});

	it('is unknown, with the reason, when Caddy is unreachable or refuses for another reason', async () => {
		const admin = new PluginAdmin();
		admin.reachable = false;
		const down = await new PluginDetector(admin).check();
		expect(down.state).toBe('unknown');
		expect(down.reason).toContain('unreachable');

		const odd = new PluginAdmin();
		odd.adapt = async () => ({
			ok: false,
			diagnostics: [{ severity: 'error', source: 'adapt', message: 'unrecognized global option: acme_dns' }]
		});
		expect(await new PluginDetector(odd).check()).toMatchObject({
			state: 'unknown',
			reason: 'unrecognized global option: acme_dns'
		});
	});

	it('keeps the answer until Caddy restarts, and looks at most every 30 seconds', async () => {
		const admin = new PluginAdmin();
		let now = 1_000_000;
		let metricsCalls = 0;
		const metrics = admin.metrics.bind(admin);
		admin.metrics = async () => {
			metricsCalls++;
			return metrics();
		};
		const d = new PluginDetector(admin, () => now);
		expect((await d.check()).state).toBe('present');
		await d.check();
		expect([admin.adapts.length, metricsCalls]).toEqual([1, 1]);

		// Later, same process: one look at the start time, no new probe, even though the build "changed".
		now += 31_000;
		admin.hasPlugin = false;
		expect((await d.check()).state).toBe('present');
		expect([admin.adapts.length, metricsCalls]).toEqual([1, 2]);

		// Caddy was replaced: the start time moved, so it is asked again.
		now += 31_000;
		admin.metricsText = admin.metricsText.replace('1.7e+09', '1.8e+09');
		expect((await d.check()).state).toBe('missing');
		expect(admin.adapts).toHaveLength(2);

		// Forcing asks again at once.
		admin.hasPlugin = true;
		expect((await d.check({ force: true })).state).toBe('present');
		expect(admin.adapts).toHaveLength(3);
	});

	it('asks again after an unknown answer, and shares one probe between concurrent callers', async () => {
		const admin = new PluginAdmin();
		let now = 0;
		admin.reachable = false;
		const d = new PluginDetector(admin, () => now);
		expect((await d.check()).state).toBe('unknown');
		admin.reachable = true;
		admin.adapts.length = 0;
		now += 31_000;
		const [a, b] = await Promise.all([d.check(), d.check()]);
		expect(a.state).toBe('present');
		expect(b).toBe(a);
		expect(admin.adapts).toHaveLength(1);
	});

	it('lets an unexpected failure through instead of calling it "unknown"', async () => {
		const admin = new PluginAdmin();
		admin.adapt = async () => {
			throw new TypeError('bug');
		};
		await expect(new PluginDetector(admin).check()).rejects.toThrow('bug');
		expect(new AdminUnreachableError('http://caddy:2019', new Error('x')).message).toContain('unreachable');
	});
});
