import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lightBlock, render } from '../../../scripts/gen-theme-system.mjs';

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
type Block = Map<string, string>;

describe('Caddy UI theme', () => {
	const caddy = read('./theme-caddy.css');
	const dark: Block = lightBlock(caddy, ":root,\n[data-theme='dark']");
	const light: Block = lightBlock(caddy, "[data-theme='light']");

	it('overrides only colour and font tokens (PLAN.md §6)', () => {
		const forbidden = /^--(space|radius|size|duration|ease|chart|shadow)-/;
		for (const name of [...dark.keys(), ...light.keys()]) expect(name).not.toMatch(forbidden);
	});

	it('overrides the same tokens in both themes', () => {
		expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
	});

	it('only overrides tokens Fishnet defines', () => {
		const fishnet: Block = lightBlock(read('./tokens.css'), '[data-theme="light"]');
		for (const name of light.keys()) expect(fishnet.has(name)).toBe(true);
	});

	it('keeps theme-system.css in sync (run pnpm gen:theme)', () => {
		expect(read('./theme-system.css')).toBe(render());
	});
});
