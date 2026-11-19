import { getRuntime } from '$lib/server/runtime';
import { UI_VERSION } from '$lib/server/version';
import type { PageServerLoad } from './$types';

/** Version and uptime. The configuration table moved to Settings (docs/settings-and-perf-plan.md D12). */
export const load: PageServerLoad = () => {
	const { startedAt } = getRuntime();
	return { version: UI_VERSION, startedAt };
};
