import { getDb, type Db } from '../db';
import { envConfig, setConfigResolver, type Config } from '../env';
import { SettingsService, type SettingsListener } from './service';

/**
 * The process-wide settings service (docs/settings-and-perf-plan.md §2.2). `installSettings()` runs first
 * in the server's `init`, so every later `config()` returns the effective config. See service.ts.
 */

export { SettingsRefused, SettingsService, KEY_PREFIX, type SettingsListener } from './service';

const KEY = Symbol.for('caddy-ui.settings');
type G = typeof globalThis & { [KEY]?: SettingsService };

/** Build the service from the environment and the database, and make `config()` use it. Idempotent. */
export function installSettings(
	opts: { db?: Db; env?: Record<string, string | undefined> } = {}
): SettingsService {
	const g = globalThis as G;
	if (!g[KEY]) {
		const env = opts.env ?? process.env;
		const service = new SettingsService(opts.db ?? getDb(), env, {
			fromEnv: opts.env ? undefined : envConfig()
		});
		for (const w of service.warnings()) console.warn(`caddy-ui: setting ${w.key}: ${w.message}`);
		if (service.ignoringSaved) {
			console.warn(
				'caddy-ui: CADDY_UI_SETTINGS_IGNORE is on; running on environment values and defaults only.'
			);
		}
		g[KEY] = service;
	}
	const service = g[KEY];
	setConfigResolver(() => service.config());
	return service;
}

/** The installed service, installing it on first use. */
export function getSettings(): SettingsService {
	return (globalThis as G)[KEY] ?? installSettings();
}

/** Run `fn` after each change to an editable setting. Returns a function that unsubscribes. */
export function onSettingsChange(fn: SettingsListener): () => void {
	return getSettings().subscribe(fn);
}

/** The effective config; the same object `config()` returns once the service is installed. */
export function effectiveConfig(): Config {
	return getSettings().config();
}

/** Tests only: forget the service and let `config()` fall back to the environment. */
export function resetSettingsForTests(): void {
	delete (globalThis as G)[KEY];
	setConfigResolver(undefined);
}
