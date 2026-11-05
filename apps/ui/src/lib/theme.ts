/** Theme and sidebar preferences, remembered per device in cookies so the server renders them. */
export type Theme = 'dark' | 'light' | 'system';
export type SidebarState = 'full' | 'rail' | 'hidden';

export const THEME_COOKIE = 'theme';
export const SIDEBAR_COOKIE = 'sidebar';
export const PREF_MAX_AGE = 60 * 60 * 24 * 365;

export function parseTheme(value: string | undefined): Theme {
	return value === 'dark' || value === 'light' ? value : 'system';
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
