import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../db';
import { Prefs, PrefsRefused } from './prefs';
import { DISPLAY_DEFAULTS } from '$lib/display';

/** Display preferences (S6, D20): saved on the server, defaults when nothing is saved. */

describe('Prefs', () => {
	it('starts on the defaults and saves only what it is given', () => {
		const p = new Prefs(openDb(':memory:'));
		expect(p.get()).toEqual(DISPLAY_DEFAULTS);
		expect(p.saved()).toEqual([]);
		expect(p.set({ clock: '12h', range: '7d' })).toMatchObject({
			clock: '12h',
			range: '7d',
			dateFormat: 'dmy'
		});
		expect(p.saved().sort()).toEqual(['clock', 'range']);
	});

	it('keeps what was saved across a restart of the service', () => {
		const db = openDb(':memory:');
		new Prefs(db).set({ landing: '/sites', theme: 'dark' });
		expect(new Prefs(db).get()).toMatchObject({ landing: '/sites', theme: 'dark' });
	});

	it('removes a saved value with null and tells the listeners', () => {
		const p = new Prefs(openDb(':memory:'));
		const seen = vi.fn();
		p.subscribe(seen);
		p.set({ range: '30d' });
		p.set({ range: null });
		expect(p.get().range).toBe('24h');
		expect(seen).toHaveBeenCalledTimes(2);
		expect(seen.mock.calls[0]?.[0].range).toBe('30d');
		expect(seen.mock.calls[0]?.[1].range).toBe('24h');
	});

	it('refuses an unknown key or value and saves nothing', () => {
		const p = new Prefs(openDb(':memory:'));
		expect(() => p.set({ clock: '12h', range: '90d' })).toThrow(PrefsRefused);
		expect(() => p.set({ landing: 'https://example.com' })).toThrow(PrefsRefused);
		expect(() => p.set({ nope: 'x' } as never)).toThrow(PrefsRefused);
		expect(p.saved()).toEqual([]);
		expect(p.get()).toEqual(DISPLAY_DEFAULTS);
	});

	it('ignores a bad value already in the table', () => {
		const db = openDb(':memory:');
		db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('pref.landing', '//evil.example');
		expect(new Prefs(db).get().landing).toBe('/');
	});

	it('does not touch the cfg. settings', () => {
		const db = openDb(':memory:');
		db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('cfg.TZ', 'UTC');
		const p = new Prefs(db);
		p.set({ clock: '12h' });
		p.reset();
		expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('cfg.TZ')).toEqual({ value: 'UTC' });
	});
});
