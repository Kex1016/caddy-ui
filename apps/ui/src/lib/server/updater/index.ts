import { config } from '../env';
import { getSettings } from '../settings';
import { UI_VERSION } from '../version';
import { requestCheckNow, syncInterval, updatesView } from './channel';

export { readControl, readStatus, updatesView } from './channel';

const KEY = 'CADDY_UI_UPDATE_INTERVAL';

/**
 * Tell the updater the interval saved in Settings, or hand the choice back to its environment when nothing is
 * saved (D13). Runs at boot and after each change to that setting. A directory that cannot be written is a warning,
 * not an error: the UI works without the updater.
 */
export function syncUpdaterInterval(): void {
	const row = getSettings()
		.view()
		.settings.find((s) => s.key === KEY);
	const saved = row && row.editable && row.source === 'saved' ? row.value : null;
	const dir = config().updaterDir;
	try {
		syncInterval(dir, saved);
	} catch (err) {
		console.warn(
			`caddy-ui: could not write the update interval to ${dir} (${err instanceof Error ? err.message : String(err)}); the updater keeps its own interval`
		);
	}
}

/** What the Settings page shows about the updater. */
export function getUpdates() {
	return updatesView(config().updaterDir, UI_VERSION);
}

/** "Check now": throws when the channel directory cannot be written. */
export function checkNow(): string {
	return requestCheckNow(config().updaterDir);
}

export function updateKeyChanged(changed: readonly string[]): boolean {
	return changed.includes(KEY);
}
