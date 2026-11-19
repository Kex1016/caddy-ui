import { describe, expect, it } from 'vitest';
import {
	effectiveSidebar,
	effectiveTheme,
	nextSidebar,
	nextTheme,
	parseSidebar,
	parseTheme,
	themeAttribute
} from './theme';

describe('theme preferences', () => {
	it('cycles dark → light → system', () => {
		expect(nextTheme('dark')).toBe('light');
		expect(nextTheme('light')).toBe('system');
		expect(nextTheme('system')).toBe('dark');
	});
	it('parses cookies defensively', () => {
		expect(parseTheme('dark')).toBe('dark');
		expect(parseTheme('"><script>')).toBe('system');
		expect(parseTheme(undefined)).toBe('system');
		expect(parseSidebar('rail')).toBe('rail');
		expect(parseSidebar('x')).toBe('full');
	});
	it('cycles the sidebar full → rail → hidden', () => {
		expect(nextSidebar('full')).toBe('rail');
		expect(nextSidebar('rail')).toBe('hidden');
		expect(nextSidebar('hidden')).toBe('full');
	});
	it('renders the html attribute', () => {
		expect(themeAttribute('light')).toBe(' data-theme="light"');
		expect(themeAttribute('system')).toBe('');
	});
});

describe('saved defaults and per-browser overrides (D20)', () => {
	it('uses the cookie when there is one, "system" included', () => {
		expect(effectiveTheme('light', () => 'dark')).toBe('light');
		expect(effectiveTheme('system', () => 'dark')).toBe('system');
		expect(effectiveSidebar('rail', () => 'hidden')).toBe('rail');
	});
	it('falls back to the saved default for no cookie or a bad one', () => {
		expect(effectiveTheme(undefined, () => 'dark')).toBe('dark');
		expect(effectiveTheme('"><script>', () => 'light')).toBe('light');
		expect(effectiveSidebar(undefined, () => 'hidden')).toBe('hidden');
	});
});
