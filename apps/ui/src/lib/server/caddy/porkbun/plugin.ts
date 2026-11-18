import { PORKBUN_PLUGIN_MODULE, type PluginCheck } from '$lib/api/porkbun-caddy';
import { config } from '../../env';
import { AdminError, AdminUnreachableError, CaddyAdmin } from '../admin';
import { processFacts } from '../inspect';

/**
 * Does the running Caddy have the Porkbun DNS plugin (docs/porkbun-plan.md §4)?
 *
 * Asked by having Caddy adapt a three-line Caddyfile that uses `acme_dns porkbun` (`POST /adapt`, through
 * `CaddyAdmin` and so through `adminFetch`). Adapting loads nothing and sends nothing anywhere: the two
 * values are `{env.…}` placeholders, which the adapter keeps as text. A Caddy without the plugin answers
 * "module not registered: dns.providers.porkbun".
 *
 * The answer can only change when Caddy is replaced, so it is kept until Caddy's process start time (from
 * its metrics) changes. That is looked at no more than every 30 seconds.
 */
export const PROBE_CADDYFILE = [
	'{',
	'\tacme_dns porkbun {',
	'\t\tapi_key {env.PORKBUN_API_KEY}',
	'\t\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}',
	'\t}',
	'}',
	''
].join('\n');

const NOT_REGISTERED = /module not registered:\s*dns\.providers\.porkbun\b/;
const LOOK_AGAIN_MS = 30_000;

export type PluginAdmin = Pick<CaddyAdmin, 'adapt' | 'metrics'>;

export class PluginDetector {
	#last: { check: PluginCheck; startedAt: number | null; lookedAt: number } | undefined;
	#running: Promise<PluginCheck> | undefined;

	constructor(
		private readonly admin: PluginAdmin,
		private readonly now: () => number = Date.now
	) {}

	/** Never throws: a Caddy that can not be asked is `unknown` with the reason. */
	check(opts: { force?: boolean } = {}): Promise<PluginCheck> {
		const last = this.#last;
		if (last && !opts.force && this.now() - last.lookedAt < LOOK_AGAIN_MS) return Promise.resolve(last.check);
		this.#running ??= this.#look(opts.force === true).finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	async #look(force: boolean): Promise<PluginCheck> {
		const startedAt = await this.#startedAt();
		const last = this.#last;
		const sameProcess = startedAt !== null && last?.startedAt === startedAt;
		if (last && !force && sameProcess && last.check.state !== 'unknown') {
			last.lookedAt = this.now();
			return last.check;
		}
		const check = await this.#probe();
		this.#last = { check, startedAt, lookedAt: this.now() };
		return check;
	}

	async #startedAt(): Promise<number | null> {
		try {
			return processFacts(await this.admin.metrics()).startedAt;
		} catch {
			return null;
		}
	}

	async #probe(): Promise<PluginCheck> {
		const base = { module: PORKBUN_PLUGIN_MODULE, checkedAt: this.now() } as const;
		try {
			const res = await this.admin.adapt(PROBE_CADDYFILE);
			if (res.ok) return { ...base, state: 'present' };
			const message = res.diagnostics[0]?.message ?? 'Caddy refused the test Caddyfile';
			if (NOT_REGISTERED.test(message)) return { ...base, state: 'missing' };
			return { ...base, state: 'unknown', reason: message };
		} catch (err) {
			if (err instanceof AdminUnreachableError || err instanceof AdminError) {
				return { ...base, state: 'unknown', reason: err.message };
			}
			throw err;
		}
	}
}

let detector: PluginDetector | undefined;

/** The process-wide detector, built from the environment on first use. */
export function getPluginDetector(): PluginDetector {
	detector ??= new PluginDetector(new CaddyAdmin(config().adminUrl, { timeoutMs: 5_000 }));
	return detector;
}

/** Tests only. */
export function setPluginDetectorForTests(d: PluginDetector | undefined): void {
	detector = d;
}
