import { join } from 'node:path';
import { CaddyAdmin } from '../caddy/admin';
import { getDb } from '../db';
import { config } from '../env';
import { getParser } from './parser';
import { ConfigService } from './service';

let service: ConfigService | undefined;

/** The process-wide config service, built from the environment on first use. */
export function getConfigService(): ConfigService {
	if (!service) {
		const cfg = config();
		service = new ConfigService({
			admin: new CaddyAdmin(cfg.adminUrl),
			db: getDb(),
			caddyfilePath: cfg.caddyfilePath,
			backupDir: join(cfg.uiData, 'backups'),
			parser: getParser
		});
	}
	return service;
}

/** Tests only. */
export function setConfigServiceForTests(s: ConfigService | undefined): void {
	service = s;
}

/** Record the file as found on disk and start watching it for outside edits. Never throws. */
export async function startConfigService(): Promise<void> {
	try {
		const s = getConfigService();
		await s.init();
		s.watch();
	} catch (err) {
		console.error(
			`caddy-ui: the config service could not start (${err instanceof Error ? err.message : String(err)}); Caddyfile history and outside-edit detection are off until it can`
		);
	}
}
