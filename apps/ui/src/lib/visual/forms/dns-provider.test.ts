/**
 * P5: the DNS provider picker of `tls`, `acme_dns` and the global `dns` option (docs/porkbun-plan.md §4).
 * The Svelte field only calls the functions tested here.
 */
import { describe, expect, it } from 'vitest';
import { parse, print, type Directive, type GlobalBlock, type SiteBlock } from '@caddy-ui/caddyfile';
import { schema, validateBlocks } from '@caddy-ui/caddy-schema';
import { cstToBlocks, LineIndex } from '$lib/editor/analyze';
import {
	addPorkbunChallenge,
	chooseNone,
	chooseOther,
	choosePorkbun,
	dnsChoice,
	dnsClaims,
	dnsLine,
	literalKeys,
	otherProviderFields,
	porkbunFields
} from './directives/dns-provider';
import { formForDirective, formForGlobalOption, unclaimedLines } from './index';
import { findField } from '../testing';

const BLOCK = [
	'\t\tdns porkbun {',
	'\t\t\tapi_key {env.PORKBUN_API_KEY}',
	'\t\t\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}',
	'\t\t}'
].join('\n');

function site(text: string) {
	const r = parse(text);
	const block = r.file.blocks.find((b): b is SiteBlock => b.kind === 'site')!;
	const tls = () => block.body.find((n): n is Directive => n.kind === 'directive' && n.name.text === 'tls')!;
	return { r, block, tls, out: () => print(r.file) };
}

function globals(text: string, name: string) {
	const r = parse(text);
	const block = r.file.blocks.find((b): b is GlobalBlock => b.kind === 'global')!;
	const node = block.body.find((n): n is Directive => n.kind === 'directive' && n.name.text === name)!;
	return { r, node, out: () => print(r.file) };
}

/** Schema findings of a text, as the editors compute them. */
function findings(text: string) {
	const { blocks } = cstToBlocks(parse(text).file, new LineIndex(text));
	return validateBlocks(schema, blocks).map((d) => `${d.severity} ${d.code}`);
}

describe('tls: DNS provider', () => {
	it('choosing Porkbun writes the plugin block with the env placeholders', () => {
		const s = site('*.example.com {\n\ttls {\n\t}\n\trespond "ok"\n}\n');
		expect(dnsChoice(s.tls())).toBe('none');
		choosePorkbun(s.tls());
		expect(s.out()).toBe(`*.example.com {\n\ttls {\n${BLOCK}\n\t}\n\trespond "ok"\n}\n`);
		expect(dnsChoice(s.tls())).toBe('porkbun');
		expect(findings(s.out())).toEqual([]);
		// Choosing it again changes nothing.
		choosePorkbun(s.tls());
		expect(s.out()).toBe(`*.example.com {\n\ttls {\n${BLOCK}\n\t}\n\trespond "ok"\n}\n`);
	});

	it('works on a tls line that has no block yet, and keeps its other options', () => {
		const bare = site('a.example.com {\n\ttls me@example.com\n}\n');
		choosePorkbun(bare.tls());
		expect(bare.out()).toBe(`a.example.com {\n\ttls me@example.com {\n${BLOCK}\n\t}\n}\n`);

		const full = site('a.example.com {\n\ttls {\n\t\t# keep me\n\t\tresolvers 1.1.1.1\n\t}\n}\n');
		choosePorkbun(full.tls());
		expect(full.out()).toBe(
			`a.example.com {\n\ttls {\n\t\t# keep me\n\t\tresolvers 1.1.1.1\n${BLOCK}\n\t}\n}\n`
		);
	});

	it('replaces another provider and drops what belonged to it', () => {
		const s = site('a.example.com {\n\ttls {\n\t\tdns cloudflare {env.CF_API_TOKEN}\n\t}\n}\n');
		expect(dnsChoice(s.tls())).toBe('other');
		choosePorkbun(s.tls());
		expect(s.out()).toBe(`a.example.com {\n\ttls {\n${BLOCK}\n\t}\n}\n`);

		const blocky = site(
			'a.example.com {\n\ttls {\n\t\tdns route53 {\n\t\t\tregion eu-central-1\n\t\t}\n\t}\n}\n'
		);
		choosePorkbun(blocky.tls());
		expect(blocky.out()).toBe(`a.example.com {\n\ttls {\n${BLOCK}\n\t}\n}\n`);
	});

	it('keeps values that are already there and fills in a missing option', () => {
		const s = site(
			'a.example.com {\n\ttls {\n\t\tdns porkbun {\n\t\t\tapi_key {env.MY_KEY} # mine\n\t\t}\n\t}\n}\n'
		);
		choosePorkbun(s.tls());
		expect(s.out()).toBe(
			'a.example.com {\n\ttls {\n\t\tdns porkbun {\n\t\t\tapi_key {env.MY_KEY} # mine\n' +
				'\t\t\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}\n\t\t}\n\t}\n}\n'
		);
	});

	it('another provider is free text; leaving Porkbun drops its block', () => {
		const s = site(`a.example.com {\n\ttls {\n${BLOCK}\n\t}\n}\n`);
		chooseOther(s.tls(), 'cloudflare');
		expect(s.out()).toBe('a.example.com {\n\ttls {\n\t\tdns cloudflare\n\t}\n}\n');
		const line = dnsLine(s.tls())!;
		findField(otherProviderFields, 'credentials', 'list').set(line, ['{env.CF_API_TOKEN}']);
		expect(s.out()).toBe('a.example.com {\n\ttls {\n\t\tdns cloudflare {env.CF_API_TOKEN}\n\t}\n}\n');
		// Renaming keeps the credentials.
		chooseOther(s.tls(), 'hetzner');
		expect(s.out()).toBe('a.example.com {\n\ttls {\n\t\tdns hetzner {env.CF_API_TOKEN}\n\t}\n}\n');
		findField(otherProviderFields, 'options', 'rows').set(line, [['api_token', '{env.TOKEN}']]);
		expect(s.out()).toBe(
			'a.example.com {\n\ttls {\n\t\tdns hetzner {env.CF_API_TOKEN} {\n\t\t\tapi_token {env.TOKEN}\n\t\t}\n\t}\n}\n'
		);
	});

	it('none removes the dns line and an emptied block', () => {
		const s = site(`a.example.com {\n\ttls {\n${BLOCK}\n\t}\n}\n`);
		chooseNone(s.tls());
		expect(s.out()).toBe('a.example.com {\n\ttls\n}\n');
		expect(dnsChoice(s.tls())).toBe('none');
	});

	it('a bare dns line means the global default provider', () => {
		const s = site('a.example.com {\n\ttls {\n\t\tdns\n\t}\n}\n');
		expect(dnsChoice(s.tls())).toBe('default');
	});

	it('the Porkbun fields read and write the block; clearing one puts the placeholder back', () => {
		const s = site(`a.example.com {\n\ttls {\n${BLOCK}\n\t}\n}\n`);
		const line = dnsLine(s.tls())!;
		const key = findField(porkbunFields, 'api_key', 'text');
		expect(key.get(line)).toBe('{env.PORKBUN_API_KEY}');
		key.set(line, key.get(line));
		expect(s.out()).toBe(`a.example.com {\n\ttls {\n${BLOCK}\n\t}\n}\n`);
		key.set(line, 'pk1_written_out');
		expect(literalKeys(s.tls())).toEqual(['api_key']);
		expect(findings(s.out())).toEqual(['warning literal-secret']);
		key.set(line, undefined);
		expect(literalKeys(s.tls())).toEqual([]);
		expect(s.out()).toBe(`a.example.com {\n\ttls {\n${BLOCK}\n\t}\n}\n`);
	});

	it('the tls form shows the picker and leaves no dns line to "other lines"', () => {
		const spec = formForDirective(schema, 'tls').spec;
		expect(findField(spec.fields, 'dns', 'custom').label).toBe('DNS provider');
		const s = site(`a.example.com {\n\ttls {\n${BLOCK}\n\t\tresolvers 1.1.1.1\n\t}\n}\n`);
		expect(unclaimedLines(spec, s.tls())).toEqual([]);
	});
});

describe('acme_dns and the global dns option', () => {
	const GLOBAL_BLOCK = [
		'\tacme_dns porkbun {',
		'\t\tapi_key {env.PORKBUN_API_KEY}',
		'\t\tapi_secret_key {env.PORKBUN_API_SECRET_KEY}',
		'\t}'
	].join('\n');

	it('choosing Porkbun writes the block on the option itself', () => {
		const g = globals('{\n\temail me@example.com\n\tacme_dns cloudflare {env.CF_API_TOKEN}\n}\n', 'acme_dns');
		expect(dnsChoice(g.node)).toBe('other');
		choosePorkbun(g.node);
		expect(g.out()).toBe(`{\n\temail me@example.com\n${GLOBAL_BLOCK}\n}\n`);
		expect(findings(g.out())).toEqual([]);
	});

	it('a freshly added option becomes the block too', () => {
		const g = globals('{\n\tacme_dns\n}\n', 'acme_dns');
		expect(dnsChoice(g.node)).toBe('default');
		choosePorkbun(g.node);
		expect(g.out()).toBe(`{\n${GLOBAL_BLOCK}\n}\n`);
		chooseNone(g.node);
		expect(g.out()).toBe('{\n\tacme_dns\n}\n');
	});

	it('the same picker serves the global dns option', () => {
		const g = globals('{\n\tdns\n}\n', 'dns');
		choosePorkbun(g.node);
		expect(g.out()).toBe(`{\n${GLOBAL_BLOCK.replace('acme_dns', 'dns')}\n}\n`);
		chooseOther(g.node, 'cloudflare');
		expect(g.out()).toBe('{\n\tdns cloudflare\n}\n');
	});

	it('both options have the bespoke form, which claims the whole provider block', () => {
		for (const name of ['acme_dns', 'dns']) {
			const lookup = formForGlobalOption(schema, name);
			expect(lookup.source, name).toBe('bespoke');
			expect(findField(lookup.spec.fields, 'provider', 'custom').label).toBe('DNS provider');
		}
		const g = globals(`{\n${GLOBAL_BLOCK}\n}\n`, 'acme_dns');
		expect(dnsClaims(g.node)).toEqual(['api_key', 'api_secret_key']);
		expect(unclaimedLines(formForGlobalOption(schema, 'acme_dns').spec, g.node)).toEqual([]);
	});
});

describe('adding the Porkbun challenge to a site (the wildcard hint)', () => {
	it('creates the tls line after the named matchers', () => {
		const s = site('*.example.com {\n\t@api path /api/*\n\treverse_proxy 10.0.0.5:80\n}\n');
		expect(addPorkbunChallenge(s.block)).toBe(true);
		expect(s.out()).toBe(
			`*.example.com {\n\t@api path /api/*\n\ttls {\n${BLOCK}\n\t}\n\treverse_proxy 10.0.0.5:80\n}\n`
		);
		expect(findings(s.out())).toEqual([]);
	});

	it('extends an existing tls line and says when there is nothing to add', () => {
		const s = site('*.example.com {\n\ttls me@example.com\n\trespond "ok"\n}\n');
		expect(addPorkbunChallenge(s.block)).toBe(true);
		expect(s.out()).toBe(`*.example.com {\n\ttls me@example.com {\n${BLOCK}\n\t}\n\trespond "ok"\n}\n`);
		expect(addPorkbunChallenge(s.block)).toBe(false);
	});
});
