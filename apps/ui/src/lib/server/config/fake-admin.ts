import type { Diagnostic } from '$lib/api/config';
import { AdminUnreachableError, type AdaptResult } from '../caddy/admin';
import type { AdminApi } from './service';

/**
 * A stand-in for Caddy's admin API in unit tests. It "adapts" a Caddyfile to a JSON config that is a pure
 * function of its non-comment, non-blank lines (so comments and blank lines change the file but not the
 * config, as with real Caddy), and rejects any line starting with `bogus` the way Caddy rejects an unknown
 * directive. The real API is exercised by `config.caddy-test.ts` in CI.
 */
export class FakeAdmin implements AdminApi {
	running: unknown = null;
	reachable = true;
	loads: string[] = [];
	failNextLoad: string | null = null;
	metricsText = [
		'# TYPE process_start_time_seconds gauge',
		'process_start_time_seconds 1.7e+09',
		'caddy_config_last_reload_successful 1',
		'caddy_config_last_reload_success_timestamp_seconds 1.7000001e+09'
	].join('\n');
	upstreamList = [{ address: '10.0.0.20:8096', num_requests: 2, fails: 0 }];

	private guard(): void {
		if (!this.reachable)
			throw new AdminUnreachableError('http://caddy:2019', new Error('connect ECONNREFUSED'));
	}

	static adaptText(text: string): AdaptResult {
		const lines = text.split('\n');
		const kept: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const line = (lines[i] as string).trim();
			if (line.startsWith('bogus')) {
				const d: Diagnostic = {
					severity: 'error',
					source: 'adapt',
					message: `Caddyfile:${i + 1}: unrecognized directive: ${line.split(/\s+/)[0]}`,
					line: i + 1
				};
				return { ok: false, diagnostics: [d] };
			}
			if (line && !line.startsWith('#')) kept.push(line);
		}
		const hostLines = kept.filter((l) => /^[a-z0-9.-]+\.[a-z]+ \{$/.test(l));
		const routes = hostLines.map((l, i) => ({
			match: [{ host: [l.slice(0, -1).trim()] }],
			handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `10.0.0.${20 + i}:8096` }] }]
		}));
		return {
			ok: true,
			config: { apps: { http: { servers: { srv0: { routes } } } }, lines: kept },
			diagnostics: []
		};
	}

	async getConfig(): Promise<unknown> {
		this.guard();
		return this.running;
	}

	async adapt(text: string): Promise<AdaptResult> {
		this.guard();
		return FakeAdmin.adaptText(text);
	}

	async load(text: string): Promise<void> {
		this.guard();
		if (this.failNextLoad) {
			const msg = this.failNextLoad;
			this.failNextLoad = null;
			const { AdminError } = await import('../caddy/admin');
			throw new AdminError(400, msg);
		}
		const adapted = FakeAdmin.adaptText(text);
		if (!adapted.ok) throw new Error('load called with invalid text');
		this.loads.push(text);
		this.running = adapted.config;
	}

	async upstreams() {
		this.guard();
		return this.upstreamList;
	}

	async metrics(): Promise<string> {
		this.guard();
		return this.metricsText;
	}
}
