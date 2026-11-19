import { describe, expect, it } from 'vitest';
import {
	C,
	COMPONENTS_V2_FLAG,
	allowedMentions,
	buildComponents,
	checkComponents,
	checkTemplate,
	coerceTemplate,
	componentsPayload,
	defaultRaw,
	defaultTemplate,
	embedPayload,
	escapeMarkdown,
	expiresIn,
	fill,
	makeVars,
	sampleVars,
	walk,
	type Component
} from './templates';
import { EVENTS } from './types';

const NOW = Date.UTC(2026, 10, 19, 10, 0);
const vars = (values: Record<string, string>) =>
	makeVars(values, { since: NOW - 120_000, time: NOW }, 'Europe/Budapest');

describe('default templates', () => {
	it('every event has a default that passes its own checks, in fields and as raw JSON', () => {
		for (const k of EVENTS) {
			const t = defaultTemplate(k);
			expect(checkTemplate(t), k).toEqual({});
			expect(checkTemplate({ ...t, advanced: true, raw: defaultRaw(k, t) }), k).toEqual({});
		}
	});

	it('upstream events are off by default, the rest on', () => {
		const off = EVENTS.filter((k) => !defaultTemplate(k).enabled);
		expect(off).toEqual(['upstream_down', 'upstream_up']);
	});

	it('every sample fills every placeholder its default uses', () => {
		for (const k of EVENTS) {
			const t = defaultTemplate(k);
			const v = sampleVars(k, { now: NOW, publicUrl: 'https://ui.example.com', timeZone: 'UTC' });
			const text = JSON.stringify(buildComponents(k, t, v));
			expect(text, k).not.toMatch(/\{[a-z_]+\}/);
		}
	});
});

describe('fill', () => {
	it('replaces known placeholders, escapes markdown in values, and leaves unknown ones', () => {
		const v = vars({ site: '*.example.com', url: 'https://ui.example.com/sites/a_b' });
		expect(fill('{site} at {url} {nope}', v)).toBe(
			'\\*.example.com at https://ui.example.com/sites/a_b {nope}'
		);
	});

	it('uses Discord timestamps, or plain text where Discord would not render them', () => {
		const v = vars({});
		expect(fill('{since}', v)).toBe(`<t:${Math.floor((NOW - 120_000) / 1000)}:f>`);
		expect(fill('{since}', v, { plain: true })).toBe('19 Nov 2026, 10:58 CET');
	});

	it('escapes every markdown character Discord reads inline', () => {
		expect(escapeMarkdown('a*b_c~d|e`f>g[h]')).toBe('a\\*b\\_c\\~d\\|e\\`f\\>g\\[h\\]');
	});

	it('expiresIn reads as a phrase', () => {
		expect(expiresIn(9.5 * 86_400_000)).toBe('9 days');
		expect(expiresIn(1.2 * 86_400_000)).toBe('1 day');
		expect(expiresIn(3_600_000)).toBe('under a day');
	});
});

describe('Components v2 payload', () => {
	it('is a container with the accent colour, heading, body, time and a link button', () => {
		const t = defaultTemplate('site_down');
		const v = vars({ site: 'app.example.com', error: 'HTTP 502', url: 'https://ui.example.com/sites/x' });
		const p = componentsPayload('site_down', t, v);
		expect(p.flags).toBe(COMPONENTS_V2_FLAG);
		expect(p.allowed_mentions).toEqual({ parse: [] });
		const [box] = p.components as [Component];
		expect(box.type).toBe(C.Container);
		expect(box.accent_color).toBe(0xe5484d);
		const kids = box.components as Component[];
		expect(kids[0]).toEqual({ type: C.TextDisplay, content: '### app.example.com is down' });
		expect(kids[1]?.content).toContain('**Error:** HTTP 502');
		expect(kids[2]?.content).toMatch(/^-# Caddy UI · <t:\d+:f>$/);
		expect(kids[3]).toEqual({
			type: C.ActionRow,
			components: [{ type: C.Button, style: 5, label: 'Open site', url: 'https://ui.example.com/sites/x' }]
		});
		expect(checkComponents(p.components)).toBeNull();
	});

	it('leaves the button out without a public address', () => {
		const p = componentsPayload('site_down', defaultTemplate('site_down'), vars({ site: 'a', url: '' }));
		const types: number[] = [];
		walk(p.components, (c) => types.push(c.type));
		expect(types).not.toContain(C.Button);
	});

	it('puts the mention first and allows only it to ping', () => {
		const t = { ...defaultTemplate('site_down'), mention: '<@&123456789012345678>' };
		const p = componentsPayload('site_down', t, vars({ site: 'a', error: '@everyone' }));
		expect(p.components[0]).toEqual({ type: C.TextDisplay, content: '<@&123456789012345678>' });
		expect(p.allowed_mentions).toEqual({ parse: [], roles: ['123456789012345678'] });
		expect(allowedMentions('<@42>')).toEqual({ parse: [], users: ['42'] });
		expect(allowedMentions('@here')).toEqual({ parse: ['everyone'] });
	});

	it('raw JSON gets the placeholders filled and dead link buttons dropped', () => {
		const raw = JSON.stringify([
			{
				type: 17,
				accent_color: 255,
				components: [
					{ type: 10, content: '## {site} fell over' },
					{
						type: 9,
						components: [{ type: 10, content: 'since {since}' }],
						accessory: { type: 2, style: 5, label: 'Go', url: '{url}' }
					},
					{ type: 1, components: [{ type: 2, style: 5, label: 'Docs', url: 'https://caddyserver.com' }] }
				]
			}
		]);
		const t = { ...defaultTemplate('site_down'), advanced: true, raw };
		const out = buildComponents('site_down', t, vars({ site: 'a_b', url: '' }));
		const box = out[0] as Component;
		const kids = box.components as Component[];
		expect(kids[0]).toEqual({ type: 10, content: '## a\\_b fell over' });
		// The section lost its button (no public address) and became its text.
		expect(kids[1]).toMatchObject({ type: 10, content: expect.stringMatching(/^since <t:\d+:f>$/) });
		expect(kids[2]).toMatchObject({ type: 1 });
	});
});

describe('checks', () => {
	it('refuses interactive and unknown components', () => {
		expect(checkComponents({})).toMatch(/array/);
		expect(checkComponents([])).toMatch(/at least one/);
		expect(
			checkComponents([{ type: 1, components: [{ type: 2, style: 1, custom_id: 'x', label: 'x' }] }])
		).toMatch(/Only link buttons/);
		expect(checkComponents([{ type: 3, custom_id: 'x' }])).toMatch(/top level/);
		expect(checkComponents([{ type: 17, components: [{ type: 17, components: [] }] }])).toMatch(
			/inside a container/
		);
		expect(checkComponents([{ type: 10, content: '' }])).toMatch(/non-empty/);
		expect(
			checkComponents([{ type: 17, accent_color: -1, components: [{ type: 10, content: 'x' }] }])
		).toMatch(/accent_color/);
	});

	it('counts components and text against Discord’s limits', () => {
		const many = Array.from({ length: 39 }, () => ({ type: 10, content: 'x' }));
		expect(checkComponents(many)).toMatch(/At most 38 components/);
		expect(checkComponents([{ type: 10, content: 'x'.repeat(3900) }])).toMatch(/characters/);
	});

	it('checks the fields of a template', () => {
		const t = defaultTemplate('site_down');
		expect(checkTemplate({ ...t, accent: 'red' })).toHaveProperty('accent');
		expect(checkTemplate({ ...t, mention: 'everyone' })).toHaveProperty('mention');
		expect(checkTemplate({ ...t, heading: '', body: '' })).toHaveProperty('body');
		expect(checkTemplate({ ...t, advanced: true, raw: '[{' })).toHaveProperty('raw');
		expect(checkTemplate({ ...t, advanced: true, raw: null })).toHaveProperty('raw');
	});

	it('coerceTemplate fills gaps from the default and ignores wrong types', () => {
		const t = coerceTemplate('site_up', { heading: 'Up!', enabled: 'yes', raw: 5 });
		expect(t).toEqual({ ...defaultTemplate('site_up'), heading: 'Up!' });
	});
});

describe('embed fallback', () => {
	it('carries the heading, text, colour, link and mention', () => {
		const t = { ...defaultTemplate('site_down'), mention: '@here' };
		const v = vars({ site: 'app.example.com', error: 'HTTP 502', url: 'https://ui.example.com/sites/x' });
		const p = embedPayload('site_down', t, v, NOW);
		expect(p.content).toBe('@here');
		expect(p.allowed_mentions).toEqual({ parse: ['everyone'] });
		expect(p).not.toHaveProperty('flags');
		const [e] = p.embeds;
		expect(e?.title).toBe('app.example.com is down');
		expect(e?.color).toBe(0xe5484d);
		expect(e?.url).toBe('https://ui.example.com/sites/x');
		expect(e?.description).toContain('[Open site](https://ui.example.com/sites/x)');
		expect(e?.timestamp).toBe(new Date(NOW).toISOString());
	});

	it('is built from raw JSON too: the first # text is the title', () => {
		const raw = JSON.stringify([
			{
				type: 17,
				accent_color: 0x123456,
				components: [
					{ type: 10, content: '# {site}' },
					{ type: 10, content: 'body' }
				]
			}
		]);
		const t = { ...defaultTemplate('site_down'), advanced: true, raw };
		const p = embedPayload('site_down', t, vars({ site: 'x.example.com', url: '' }), NOW);
		expect(p.embeds[0]).toMatchObject({ title: 'x.example.com', description: 'body', color: 0x123456 });
	});
});
