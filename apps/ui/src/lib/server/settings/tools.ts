import { allCerts } from '../collector/queries';
import { getCollector } from '../collector';
import { getConfigService } from '../config';
import { getDb } from '../db';
import { config } from '../env';
import { porkbunStatus } from '../porkbun';
import { recentSlowLoads } from '../timing';
import type { DiagnosticsReport, HelperId, HelperProposal, ProbeOptionsRow } from '$lib/settings/types';
import { enableAccessLog, enableMetricsPerHost } from './caddy-helpers';
import { pathChecks } from './checks';
import { diagnose } from './diagnostics';
import { Maintenance } from './maintenance';
import { storageFacts } from './storage';
import { loadProbeOptions, saveProbeOptions, type ProbeOptions } from '../collector/probe-options';

/**
 * The S3 tools of the Settings page (docs/settings-and-perf-plan.md §3) wired to the running server: the
 * collector, the config service and the shared database. Kept apart from `settings/index.ts`, which the
 * collector itself imports.
 */

const KEY = Symbol.for('caddy-ui.maintenance');
type G = typeof globalThis & { [KEY]?: Maintenance };

/** The process-wide storage tools: prune now, compact, backup. */
export function getMaintenance(): Maintenance {
	const g = globalThis as G;
	if (!g[KEY]) {
		const db = getDb();
		const cfg = config();
		const c = getCollector();
		g[KEY] = new Maintenance({
			dbPath: db.name,
			dataDir: cfg.uiData,
			caddyfilePath: cfg.caddyfilePath,
			prune: () => c.prune(),
			hold: () => c.hold()
		});
	}
	return g[KEY];
}

/** "Check everything": every dependency of the UI in one report. Porkbun is pinged afresh. */
export async function checkEverything(): Promise<DiagnosticsReport> {
	const started = performance.now();
	const cfg = config();
	const db = getDb();
	const c = getCollector();
	const [caddy, porkbun] = await Promise.all([
		getConfigService()
			.status()
			.catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })),
		porkbunStatus({ force: true }).catch((err: unknown) => ({
			error: err instanceof Error ? err.message : String(err)
		}))
	]);
	const now = Date.now();
	const certs = allCerts(db, now);
	return diagnose({
		now,
		tookMs: Math.round(performance.now() - started),
		caddy,
		collector: c.status,
		intervals: { probes: cfg.probeIntervalMs, metrics: cfg.scrapeIntervalMs },
		paths: pathChecks(cfg),
		porkbun,
		storage: storageFacts(db, db.name, cfg.uiData, now),
		slow: recentSlowLoads(),
		certs: {
			count: certs.length,
			expired: certs.filter((x) => x.daysLeft < 0).length,
			expiringSoon: certs.filter((x) => x.daysLeft >= 0 && x.daysLeft < cfg.certWarnDays).length,
			warnDays: cfg.certWarnDays
		},
		skipped: c.sites.filter((s) => c.probeOptions.get(s.id)?.skip).length
	});
}

/** The change a Caddy helper would make to the Caddyfile as it is now, for review. */
export async function helperProposal(helper: HelperId): Promise<HelperProposal> {
	const doc = await getConfigService().document();
	const r =
		helper === 'metrics' ? enableMetricsPerHost(doc.text) : enableAccessLog(doc.text, config().logPath);
	return {
		helper,
		before: doc.text,
		after: r.changed ? r.text : doc.text,
		baseHash: doc.hash,
		summary: r.summary,
		notes: r.notes
	};
}

/** Every site with its probe options and where it is probed now. */
export function probeOptionRows(): ProbeOptionsRow[] {
	const c = getCollector();
	if (c.status.caddyfile.lastRun === null) c.refreshSites();
	return c.sites.map((s) => {
		const o = c.probeOptions.get(s.id);
		return {
			siteId: s.id,
			label: s.addresses[0] ?? s.id,
			addresses: s.addresses,
			skip: o?.skip ?? false,
			path: o?.path ?? null,
			upStatuses: o?.upStatuses ?? [],
			target: c.siteTarget(s)?.url ?? null
		};
	});
}

/** Save one site's probe options; the collector uses them from its next cycle. False when the site is unknown. */
export function saveSiteProbeOptions(siteId: string, options: ProbeOptions, author: string): boolean {
	const c = getCollector();
	const site = c.sites.find((s) => s.id === siteId);
	if (!site) return false;
	const db = getDb();
	saveProbeOptions(db, { id: site.id, label: site.addresses[0] ?? site.id }, options, author, Date.now());
	c.setProbeOptions(loadProbeOptions(db));
	return true;
}
