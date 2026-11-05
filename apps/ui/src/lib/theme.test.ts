import { describe, expect, it } from 'vitest';
import { nextSidebar, nextTheme, parseSidebar, parseTheme, themeAttribute } from './theme';

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
