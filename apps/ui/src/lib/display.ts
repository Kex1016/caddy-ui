import type { SidebarState, Theme } from './theme';

/**
 * Display preferences (docs/settings-and-perf-plan.md §3, S6): how this UI shows times and dates, which range
 * its stats start on, where `/` leads, and the default theme and sidebar. They are saved on the server, so they
 * follow the person to another browser (D20). Client-safe: the server stores them, the page only labels them.
 */

export type RangeKey = '1h' | '24h' | '7d' | '30d';
export type Clock = '24h' | '12h';
/** "4 Nov 2026", "Nov 4, 2026" and "2026-11-04". */
export type DateFormat = 'dmy' | 'mdy' | 'iso';

export type Display = {
	range: RangeKey;
	clock: Clock;
	dateFormat: DateFormat;
	/** The page `/` opens on when the address is typed, bookmarked or followed from elsewhere. */
	landing: string;
	theme: Theme;
	sidebar: SidebarState;
};

export const DISPLAY_DEFAULTS: Display = {
	range: '24h',
	clock: '24h',
	dateFormat: 'dmy',
	landing: '/',
	theme: 'system',
	sidebar: 'full'
};

export type DisplayKey = keyof Display;
export const DISPLAY_KEYS = Object.keys(DISPLAY_DEFAULTS) as DisplayKey[];

export const LANDING_PAGES = [
	{ value: '/', label: 'Overview' },
	{ value: '/sites', label: 'Sites' },
	{ value: '/domains', label: 'Domains' },
	{ value: '/editor', label: 'Editor' },
	{ value: '/globals', label: 'Globals' },
	{ value: '/history', label: 'History' },
	{ value: '/settings', label: 'Settings' }
] as const;

const CHOICES: Record<DisplayKey, readonly string[]> = {
	range: ['1h', '24h', '7d', '30d'],
	clock: ['24h', '12h'],
	dateFormat: ['dmy', 'mdy', 'iso'],
	landing: LANDING_PAGES.map((p) => p.value),
	theme: ['system', 'light', 'dark'],
	sidebar: ['full', 'rail', 'hidden']
};

export const DISPLAY_LABELS: Record<DisplayKey, Record<string, string>> = {
	range: { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' },
	clock: { '24h': '24-hour (17:44)', '12h': '12-hour (5:44 PM)' },
	dateFormat: { dmy: '4 Nov 2026', mdy: 'Nov 4, 2026', iso: '2026-11-04' },
	landing: Object.fromEntries(LANDING_PAGES.map((p) => [p.value, p.label])),
	theme: { system: 'Follow the system', light: 'Light', dark: 'Dark' },
	sidebar: { full: 'Full', rail: 'Icons only', hidden: 'Hidden' }
};

export function isDisplayChoice(key: DisplayKey, value: unknown): boolean {
	return typeof value === 'string' && CHOICES[key].includes(value);
}

/** Keep every valid value in `raw` and fill the rest from the defaults; unknown values never get in. */
export function parseDisplay(raw: Partial<Record<string, unknown>>): Display {
	const out: Record<string, unknown> = { ...DISPLAY_DEFAULTS };
	for (const key of DISPLAY_KEYS) if (isDisplayChoice(key, raw[key])) out[key] = raw[key];
	return out as Display;
}

/** The names the Preferences section uses, for the import review. */
export const DISPLAY_NAMES: Record<DisplayKey, string> = {
	range: 'Stats range',
	clock: 'Clock',
	dateFormat: 'Date format',
	landing: 'Landing page',
	theme: 'Theme',
	sidebar: 'Sidebar'
};
