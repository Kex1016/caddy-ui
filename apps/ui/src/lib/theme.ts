/** Theme and sidebar preferences, remembered per device in cookies so the server renders them. */
export type Theme = 'dark' | 'light' | 'system';
export type SidebarState = 'full' | 'rail' | 'hidden';

export const THEME_COOKIE = 'theme';
export const SIDEBAR_COOKIE = 'sidebar';
export const PREF_MAX_AGE = 60 * 60 * 24 * 365;

export function parseTheme(value: string | undefined): Theme {
	return value === 'dark' || value === 'light' ? value : 'system';
}

/**
 * The theme for a request: this browser's cookie when it has one (a per-browser override), else the one saved on
 * the server (D20). A cookie is always written when the toggle is used, "system" included, so a choice sticks.
 */
export function effectiveTheme(cookie: string | undefined, saved: () => Theme): Theme {
	return cookie === 'dark' || cookie === 'light' || cookie === 'system' ? cookie : saved();
}

export function effectiveSidebar(cookie: string | undefined, saved: () => SidebarState): SidebarState {
	return cookie === 'full' || cookie === 'rail' || cookie === 'hidden' ? cookie : saved();
}

export function nextTheme(theme: Theme): Theme {
	return theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
}

export function parseSidebar(value: string | undefined): SidebarState {
	return value === 'rail' || value === 'hidden' ? value : 'full';
}

export function nextSidebar(state: SidebarState): SidebarState {
	return state === 'full' ? 'rail' : state === 'rail' ? 'hidden' : 'full';
}

/** The `data-theme` attribute for `<html>`; system has none, so the CSS media query decides. */
export function themeAttribute(theme: Theme): string {
	return theme === 'system' ? '' : ` data-theme="${theme}"`;
}
