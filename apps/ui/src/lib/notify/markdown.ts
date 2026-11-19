/**
 * The part of Discord's markdown a notification uses, parsed into a small tree for the Settings page's preview.
 * The preview renders the tree with Svelte, never as HTML, so nothing typed into a template can inject markup.
 */

export type Inline =
	| { k: 'text'; v: string }
	| { k: 'code'; v: string }
	| { k: 'b' | 'i' | 'u' | 's'; c: Inline[] }
	| { k: 'link'; href: string; c: Inline[] }
	| { k: 'time'; ts: number; style: string }
	| { k: 'mention'; v: string };

export type Line = { k: 'h1' | 'h2' | 'h3' | 'sub' | 'quote' | 'p'; c: Inline[] };

const PUNCT = /[\\`*_~|>[\]()#\-.!{}<>@:]/;

const WRAPS: [string, 'b' | 'u' | 's' | 'i'][] = [
	['**', 'b'],
	['__', 'u'],
	['~~', 's'],
	['*', 'i'],
	['_', 'i']
];

export function inline(s: string): Inline[] {
	const out: Inline[] = [];
	let text = '';
	const flush = () => {
		if (text) out.push({ k: 'text', v: text });
		text = '';
	};
	let i = 0;
	while (i < s.length) {
		const rest = s.slice(i);
		const ch = s[i] as string;
		if (ch === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1] as string)) {
			text += s[i + 1];
			i += 2;
			continue;
		}
		if (ch === '`') {
			const end = s.indexOf('`', i + 1);
			if (end > i + 1) {
				flush();
				out.push({ k: 'code', v: s.slice(i + 1, end) });
				i = end + 1;
				continue;
			}
		}
		const wrap = WRAPS.find(([m]) => rest.startsWith(m));
		if (wrap) {
			const [m, k] = wrap;
			const end = findClose(s, m, i + m.length);
			if (end > i + m.length) {
				flush();
				out.push({ k, c: inline(s.slice(i + m.length, end)) });
				i = end + m.length;
				continue;
			}
		}
		if (ch === '[') {
			const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
			if (m) {
				flush();
				out.push({ k: 'link', href: m[2] as string, c: inline(m[1] as string) });
				i += m[0].length;
				continue;
			}
		}
		if (ch === '<') {
			const t = /^<t:(-?\d{1,13})(?::([tTdDfFR]))?>/.exec(rest);
			if (t) {
				flush();
				out.push({ k: 'time', ts: Number(t[1]) * 1000, style: t[2] ?? 'f' });
				i += t[0].length;
				continue;
			}
			const role = /^<@&(\d+)>/.exec(rest);
			const user = role ? null : /^<@!?(\d+)>/.exec(rest);
			if (role || user) {
				flush();
				out.push({ k: 'mention', v: role ? '@role' : '@user' });
				i += (role ?? user)![0].length;
				continue;
			}
		}
		if (ch === '@') {
			const m = /^@(here|everyone)\b/.exec(rest);
			if (m) {
				flush();
				out.push({ k: 'mention', v: m[0] });
				i += m[0].length;
				continue;
			}
		}
		text += ch;
		i++;
	}
	flush();
	return out;
}

/** The closing marker, skipping escaped characters; -1 when there is none. */
function findClose(s: string, marker: string, from: number): number {
	for (let j = from; j <= s.length - marker.length; j++) {
		if (s[j] === '\\') {
			j++;
			continue;
		}
		if (s.startsWith(marker, j)) {
			// `**` must not be read as the end of a single `*`.
			if (marker.length === 1 && s[j + 1] === marker) {
				j++;
				continue;
			}
			return j;
		}
	}
	return -1;
}

export function parse(text: string): Line[] {
	return text.split('\n').map((raw) => {
		const m = /^(#{1,3}) (.*)$/.exec(raw);
		if (m)
			return { k: (['h1', 'h2', 'h3'] as const)[(m[1] as string).length - 1]!, c: inline(m[2] as string) };
		if (raw.startsWith('-# ')) return { k: 'sub', c: inline(raw.slice(3)) };
		if (raw.startsWith('> ')) return { k: 'quote', c: inline(raw.slice(2)) };
		return { k: 'p', c: inline(raw) };
	});
}
