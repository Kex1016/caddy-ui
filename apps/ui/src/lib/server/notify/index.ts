import { getCollector } from '../collector';
import { getConfigService } from '../config';
import { getDb } from '../db';
import { config, envConfig } from '../env';
import { UI_VERSION } from '../version';
import { DiscordSender } from './discord';
import { Notifier } from './notifier';

/**
 * The process-wide notifier (docs/settings-and-perf-plan.md §3.1). `startNotifier()` runs in the server's `init`
 * after the collector starts and before the config service reads the Caddyfile, so an edit made while the UI
 * was stopped is announced too.
 */

export { NotifyRefused, Notifier, compareVersions, type CycleEntry, type SiteInfo } from './notifier';
export { DiscordSender, parseWebhookUrl, WebhookUrlError } from './discord';
export { NotifyStore, NOTIFY_PREFIX } from './store';

const KEY = Symbol.for('caddy-ui.notifier');
type G = typeof globalThis & { [KEY]?: Notifier };

export function getNotifier(): Notifier {
	const g = globalThis as G;
	g[KEY] ??= new Notifier({
		db: getDb(),
		sender: new DiscordSender({ apiBase: envConfig().discordApiUrl }),
		version: UI_VERSION,
		display: () => {
			const c = config();
			return { timeZone: c.timeZone, publicUrl: c.publicUrl };
		},
		/** The same window as the Certificates page (CADDY_UI_CERT_WARN_DAYS, S3). */
		warnDays: () => config().certWarnDays
	});
	return g[KEY];
}

/** Tests only. */
export function setNotifierForTests(n: Notifier | undefined): void {
	(globalThis as G)[KEY] = n;
}

let started = false;

/** Wire the notifier to the collector, the config service and the boot. Never throws. */
export function startNotifier(): void {
	if (started) return;
	started = true;
	try {
		const n = getNotifier();
		const c = getCollector();
		const siteList = () => c.sites.map((s) => ({ id: s.id, addresses: s.addresses }));
		n.seed(c.currentStates, siteList());
		const offCollector = c.onChange((e) => {
			if (e === 'probes') n.onCycle(c.lastCycle.ts, c.lastCycle.results, siteList());
			else if (e === 'certs') {
				const rows = getDb().prepare(`SELECT host, not_after, issuer FROM certs`).all() as {
					host: string;
					not_after: number;
					issuer: string;
				}[];
				n.onCerts(
					rows.map((r) => ({ host: r.host, notAfter: r.not_after, issuer: r.issuer })),
					(host) => c.matcher.match(host)
				);
			}
		});
		const offConfig = getConfigService().onExternalChange((change) => n.onExternalEdit(change));
		// A little after boot, so a version message does not race the first probe cycle for the rate limit.
		const t = setTimeout(() => n.checkVersion(), 5_000);
		t.unref();
		process.once('sveltekit:shutdown', () => {
			clearTimeout(t);
			offCollector();
			offConfig();
		});
	} catch (err) {
		console.error(
			`caddy-ui: notifications could not start (${err instanceof Error ? err.message : String(err)}); nothing will be sent`
		);
	}
}
