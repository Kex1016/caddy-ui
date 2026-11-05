import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanCaddyfile, siteId } from '../collector/sites';
import {
	BlockError,
	addSite,
	deleteSite,
	duplicateSite,
	moveSite,
	parseAddresses,
	scanBlocks,
	setSiteDisabled,
	starterBlock
} from './blocks';

const fixture = readFileSync(new URL('../collector/fixtures/Caddyfile', import.meta.url), 'utf8');
const SIMPLE = `{
	email admin@example.com
}

(auth) {
	forward_auth 10.0.0.1:8888
}

# The app
a.example.com {
	reverse_proxy 10.0.0.10:8080
}

b.example.com, c.example.com {
	import auth
	respond "}" 200
}

d.example.com {
	reverse_proxy 10.0.0.12:80 # trailing
}
`;

const sitesOf = (t: string) => scanBlocks(t).blocks.filter((b) => b.kind === 'site');
const labels = (t: string) => sitesOf(t).map((b) => b.addresses.join(','));

describe('scanBlocks', () => {
	it('finds the same enabled sites, ids and lines as the collector scanner', () => {
		const mine = sitesOf(fixture).map((b) => ({ id: b.id, addresses: b.addresses, line: b.line }));
		const theirs = scanCaddyfile(fixture).map((s) => ({ id: s.id, addresses: s.addresses, line: s.line }));
		expect(mine).toEqual(theirs);
	});

	it('classifies globals, snippets and sites, and ignores braces in quotes', () => {
		const kinds = scanBlocks(SIMPLE).blocks.map((b) => b.kind);
		expect(kinds).toEqual(['global', 'snippet', 'site', 'site', 'site']);
	});

	it('attaches comment lines directly above a block, but not across a blank line', () => {
		const a = sitesOf(SIMPLE)[0]!;
		expect(SIMPLE.slice(a.start, a.end).startsWith('# The app\na.example.com')).toBe(true);
		const b = sitesOf(SIMPLE)[1]!;
		expect(SIMPLE.slice(b.start, b.end).startsWith('b.example.com')).toBe(true);
	});

	it('flags a site written without braces', () => {
		expect(scanBlocks('example.com\nrespond hi\n').unsupported).toMatch(/without braces/);
	});

	it('flags an unclosed brace', () => {
		expect(scanBlocks('a.com {\n respond hi\n').unsupported).toMatch(/never closed/);
	});
});

describe('parseAddresses', () => {
	it('splits on commas and spaces and keeps schemes, ports and env vars', () => {
		expect(parseAddresses('a.com, https://b.com:8443  {$HOST}')).toEqual([
			'a.com',
			'https://b.com:8443',
			'{$HOST}'
		]);
	});
	it('rejects empty, quoted and brace-broken input', () => {
		for (const bad of ['', '  ', '"a.com"', 'a.com}', '#x'])
			expect(() => parseAddresses(bad)).toThrow(BlockError);
	});
});

describe('addSite', () => {
	it('appends after the last site with one blank line and leaves the rest alone', () => {
		const block = starterBlock(['new.example.com'], 'reverse_proxy', '10.0.0.50:3000');
		const out = addSite(SIMPLE, block, ['new.example.com']);
		expect(out.startsWith(SIMPLE.slice(0, SIMPLE.lastIndexOf('}\n') + 1))).toBe(true);
		expect(labels(out)).toEqual([
			'a.example.com',
			'b.example.com,c.example.com',
			'd.example.com',
			'new.example.com'
		]);
		expect(out.endsWith('\treverse_proxy 10.0.0.50:3000\n}\n')).toBe(true);
	});
	it('works on an empty file', () => {
		expect(addSite('', starterBlock(['a.com'], 'blank'), ['a.com'])).toBe('a.com {\n}\n');
	});
	it('refuses an address that is already a site, in any order or case', () => {
		expect(() => addSite(SIMPLE, 'x', ['C.example.com', 'b.example.com'])).toThrow(/already a site/);
	});
	it('builds each starter', () => {
		expect(starterBlock(['a.com'], 'file_server', '/srv/www')).toBe(
			'a.com {\n\troot * /srv/www\n\tfile_server\n}'
		);
		expect(starterBlock(['a.com'], 'redirect', 'https://b.com')).toBe(
			'a.com {\n\tredir https://b.com{uri} permanent\n}'
		);
		expect(() => starterBlock(['a.com'], 'reverse_proxy', '')).toThrow(/upstream/);
		expect(() => starterBlock(['a.com'], 'reverse_proxy', 'a b')).toThrow(BlockError);
	});
});

describe('duplicateSite', () => {
	it('copies the body under the new address, right after the original', () => {
		const id = siteId(['a.example.com']);
		const out = duplicateSite(SIMPLE, id, ['a2.example.com']);
		expect(out).toContain(
			'a.example.com {\n\treverse_proxy 10.0.0.10:8080\n}\n\na2.example.com {\n\treverse_proxy 10.0.0.10:8080\n}\n\nb.example.com'
		);
		expect(labels(out)).toHaveLength(4);
	});
	it('does not copy the leading comment', () => {
		const out = duplicateSite(SIMPLE, siteId(['a.example.com']), ['a2.example.com']);
		expect(out.match(/# The app/g)).toHaveLength(1);
	});
	it('copes with a multi-line address list', () => {
		const text = 'a.com,\n\tb.com {\n\trespond hi\n}\n';
		const out = duplicateSite(text, siteId(['a.com', 'b.com']), ['c.com']);
		expect(out).toBe(text + '\nc.com {\n\trespond hi\n}\n');
	});
	it('refuses an existing address and an unknown id', () => {
		expect(() => duplicateSite(SIMPLE, siteId(['a.example.com']), ['d.example.com'])).toThrow(
			/already a site/
		);
		expect(() => duplicateSite(SIMPLE, 'nope', ['x.com'])).toThrow(/no longer/);
	});
});

describe('deleteSite', () => {
	it('removes the block, its comment and one blank line', () => {
		const out = deleteSite(SIMPLE, siteId(['a.example.com']));
		expect(out).toBe(SIMPLE.replace('# The app\na.example.com {\n\treverse_proxy 10.0.0.10:8080\n}\n\n', ''));
	});
	it('removes the last block without leaving a trailing blank line', () => {
		const out = deleteSite(SIMPLE, siteId(['d.example.com']));
		expect(out.endsWith('respond "}" 200\n}\n')).toBe(true);
	});
	it('deleting the only site leaves the rest', () => {
		expect(deleteSite('a.com {\n}\n', siteId(['a.com']))).toBe('');
	});
});

describe('setSiteDisabled', () => {
	const id = siteId(['b.example.com', 'c.example.com']);
	it('comments the block out, hides it from the collector scanner and brings back identical bytes', () => {
		const off = setSiteDisabled(SIMPLE, id, true);
		expect(off).toContain('# caddy-ui:disabled lines=4\n# b.example.com, c.example.com {\n# \timport auth');
		expect(scanCaddyfile(off).map((s) => s.addresses[0])).toEqual(['a.example.com', 'd.example.com']);
		const disabled = sitesOf(off).find((b) => b.id === id)!;
		expect(disabled.disabled).toBe(true);
		expect(setSiteDisabled(off, id, false)).toBe(SIMPLE);
	});
	it('round-trips blank lines, comments and heredocs inside the block', () => {
		const text = 'a.com {\n\t# note\n\n\trespond <<EOT\n\t\thello\n\tEOT\n}\n\nb.com {\n}\n';
		const off = setSiteDisabled(text, siteId(['a.com']), true);
		expect(scanCaddyfile(off).map((s) => s.addresses[0])).toEqual(['b.com']);
		expect(setSiteDisabled(off, siteId(['a.com']), false)).toBe(text);
	});
	it('round-trips CRLF files', () => {
		const text = 'a.com {\r\n\trespond hi\r\n}\r\n\r\nb.com {\r\n}\r\n';
		const off = setSiteDisabled(text, siteId(['a.com']), true);
		expect(off).not.toMatch(/[^\r]\n/);
		expect(setSiteDisabled(off, siteId(['a.com']), false)).toBe(text);
	});
	it('is a no-op when already in the requested state, and the id survives', () => {
		expect(setSiteDisabled(SIMPLE, id, false)).toBe(SIMPLE);
		const off = setSiteDisabled(SIMPLE, id, true);
		expect(setSiteDisabled(off, id, true)).toBe(off);
	});
	it('refuses to add or duplicate onto a disabled site', () => {
		const off = setSiteDisabled(SIMPLE, id, true);
		expect(() => addSite(off, 'x', ['b.example.com', 'c.example.com'])).toThrow(/disabled site/);
		expect(() => duplicateSite(off, id, ['z.com'])).toThrow(/Enable/);
	});
	it('a hand-edited marker that no longer matches is just a comment', () => {
		const off = setSiteDisabled(SIMPLE, id, true).replace('lines=4', 'lines=9');
		expect(sitesOf(off).some((b) => b.disabled)).toBe(false);
	});
	it('works on the real-world fixture, every site', () => {
		for (const s of scanCaddyfile(fixture)) {
			const off = setSiteDisabled(fixture, s.id, true);
			expect(scanCaddyfile(off).some((x) => x.id === s.id)).toBe(false);
			expect(setSiteDisabled(off, s.id, false)).toBe(fixture);
		}
	});
});

describe('moveSite', () => {
	it('swaps a site with its neighbour, keeping the blank lines and snippets where they are', () => {
		const out = moveSite(SIMPLE, siteId(['d.example.com']), 'up');
		expect(labels(out)).toEqual(['a.example.com', 'd.example.com', 'b.example.com,c.example.com']);
		expect(out.length).toBe(SIMPLE.length);
		expect(moveSite(out, siteId(['d.example.com']), 'down')).toBe(SIMPLE);
	});
	it('carries the leading comment along', () => {
		const out = moveSite(SIMPLE, siteId(['a.example.com']), 'down');
		expect(out.indexOf('# The app')).toBeGreaterThan(out.indexOf('b.example.com'));
	});
	it('does nothing at the ends', () => {
		expect(moveSite(SIMPLE, siteId(['a.example.com']), 'up')).toBe(SIMPLE);
		expect(moveSite(SIMPLE, siteId(['d.example.com']), 'down')).toBe(SIMPLE);
	});
	it('moves past a snippet in the middle without touching it', () => {
		const text = 'a.com {\n}\n\n(s) {\n\tlog\n}\n\nb.com {\n}\n';
		const out = moveSite(text, siteId(['a.com']), 'down');
		expect(out).toBe('b.com {\n}\n\n(s) {\n\tlog\n}\n\na.com {\n}\n');
	});
	it('moves disabled sites too', () => {
		const off = setSiteDisabled(SIMPLE, siteId(['a.example.com']), true);
		const out = moveSite(off, siteId(['a.example.com']), 'down');
		expect(labels(out)[1]).toBe('a.example.com');
		expect(setSiteDisabled(out, siteId(['a.example.com']), false)).toBe(
			moveSite(SIMPLE, siteId(['a.example.com']), 'down')
		);
	});
});

describe('files these edits do not handle', () => {
	it('refuses to edit a brace-less site', () => {
		expect(() => addSite('example.com\nrespond hi\n', 'x', ['y.com'])).toThrow(BlockError);
	});
});
