import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostic } from '$lib/api/config';
import { setConfigServiceForTests } from '../../config';
import { FakeAdmin } from '../../config/fake-admin';
import { ConfigService } from '../../config/service';
import { openDb } from '../../db';
import type { AdaptResult } from '../admin';
import { PluginDetector, PROBE_CADDYFILE, setPluginDetectorForTests } from './plugin';

/** Test helpers for the Caddy tie-in. Nothing here is imported by the app. */

/** What a Caddy without the plugin answers to the probe, word for word (Caddy 2.11.2). */
export const NOT_REGISTERED =
	"parsing caddyfile tokens for 'acme_dns': getting module named 'dns.providers.porkbun': module not registered: dns.providers.porkbun, at Caddyfile:2";

/** A stand-in for Caddy that answers the plugin probe the way a build with or without the plugin does. */
export class PluginAdmin extends FakeAdmin {
	hasPlugin = true;
	adapts: string[] = [];

	override async adapt(text: string): Promise<AdaptResult> {
		this.adapts.push(text);
		if (text === PROBE_CADDYFILE && !this.hasPlugin) {
			const d: Diagnostic = { severity: 'error', source: 'adapt', message: NOT_REGISTERED, line: 2 };
			return { ok: false, diagnostics: [d] };
		}
		return super.adapt(text);
	}
}

export type TieInContext = {
	admin: PluginAdmin;
	svc: ConfigService;
	file: string;
	setCaddyfile(text: string): Promise<void>;
	cleanup(): Promise<void>;
};

/**
 * A Caddyfile on disk behind a config service, and a plugin detector on a fake Caddy. Call
 * `useFakePorkbun()` as well for the Porkbun side, and `cleanup()` in `afterEach`.
 */
export async function useTieIn(caddyfile: string, opts: { plugin?: boolean } = {}): Promise<TieInContext> {
	const dir = await mkdtemp(join(tmpdir(), 'caddy-ui-p5-'));
	const file = join(dir, 'Caddyfile');
	await writeFile(file, caddyfile);
	const admin = new PluginAdmin();
	admin.hasPlugin = opts.plugin ?? true;
	const svc = new ConfigService({
		admin,
		db: openDb(':memory:'),
		caddyfilePath: file,
		backupDir: join(dir, 'backups')
	});
	await svc.init();
	setConfigServiceForTests(svc);
	setPluginDetectorForTests(new PluginDetector(admin));
	return {
		admin,
		svc,
		file,
		setCaddyfile: (text) => writeFile(file, text),
		cleanup: async () => {
			svc.unwatch();
			setConfigServiceForTests(undefined);
			setPluginDetectorForTests(undefined);
			await rm(dir, { recursive: true, force: true });
		}
	};
}
