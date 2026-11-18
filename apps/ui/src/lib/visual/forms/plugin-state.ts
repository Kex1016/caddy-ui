/**
 * Whether the running Caddy has the Porkbun DNS plugin, for the provider picker. Asked once per page and
 * shared by every form on it; asked again after a minute so a rebuilt Caddy is noticed without a reload.
 * Browser only: the server side lives in `$lib/server/caddy/porkbun/plugin.ts`.
 */
import type { CaddyTieIn, PluginCheck } from '$lib/api/porkbun-caddy';

const MAX_AGE_MS = 60_000;
let last: { at: number; check: Promise<PluginCheck | null> } | undefined;

async function ask(): Promise<PluginCheck | null> {
	try {
		const res = await fetch('/api/porkbun/caddy?only=plugin', { headers: { accept: 'application/json' } });
		if (!res.ok) return null;
		return ((await res.json()) as Pick<CaddyTieIn, 'plugin'>).plugin ?? null;
	} catch {
		return null;
	}
}

/** null when the UI's own server could not be asked. Never rejects. */
export function porkbunPlugin(now = Date.now()): Promise<PluginCheck | null> {
	if (!last || now - last.at > MAX_AGE_MS) last = { at: now, check: ask() };
	return last.check;
}
