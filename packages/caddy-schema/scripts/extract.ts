/**
 * Turns the Caddy docs (caddyserver/website, src/docs/markdown) into a SchemaBundle.
 * Pure function of the docs directory contents plus overrides.ts, so a re-run on the
 * same commit is byte-identical.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
	ArgSchema,
	DirectiveSchema,
	GlobalOptionSchema,
	MatcherSchema,
	MatcherTokenForm,
	PlaceholderSchema,
	SchemaBundle,
	SchemaSource
} from '../src/types.ts';
import {
	sections,
	cleanInline,
	firstSentence,
	bulletDoc,
	type Section,
	type Bullet,
	type CodeBlock
} from './md.ts';
import { parseSyntaxBlock, parseArgs, tokenize, normaliseArgName, type SyntaxNode } from './syntax.ts';
import { applyOverrides, CATEGORIES, EXTRA_PLACEHOLDERS, MATCHER_TOKEN_FORMS } from './overrides.ts';

export const SCHEMA_VERSION = 1;
const SITE = 'https://caddyserver.com';

export type Docs = { root: string; read(rel: string): string; list(rel: string): string[] };

export function docsAt(root: string): Docs {
	const base = join(root, 'src/docs/markdown');
	if (!existsSync(join(base, 'caddyfile/directives.md'))) {
		throw new Error(`No Caddy docs at ${root} (expected src/docs/markdown/caddyfile/directives.md)`);
	}
	return {
		root,
		read: (rel) => readFileSync(join(base, rel), 'utf8'),
		list: (rel) =>
			readdirSync(join(base, rel))
				.filter((f) => f.endsWith('.md'))
				.sort()
	};
}

// ---------------------------------------------------------------------------
// Doc lookup helpers

/** Index of the section a heading starts, and the end (exclusive) of its region (next heading of same or higher level). */
function regionOf(secs: Section[], idx: number): [number, number] {
	const lvl = secs[idx].level;
	let end = idx + 1;
	while (end < secs.length && secs[end].level > lvl) end++;
	return [idx, end];
}

function findSection(secs: Section[], pred: (s: Section) => boolean, from = 0): number {
	for (let i = from; i < secs.length; i++) if (pred(secs[i])) return i;
	return -1;
}

/**
 * Look up bullet docs by term, preferring the bullets in `preferred` sections
 * (searched in order), then the whole file.
 */
function bulletLookup(secs: Section[], preferred: number[]) {
	return (term: string): string => {
		const want = term.toLowerCase();
		for (const i of preferred) {
			for (const b of secs[i].bullets) {
				if (bulletTerm(b) === want) return bulletDoc(b.text);
			}
		}
		// Outside the preferred sections, only use a bullet when the term is documented once:
		// `dial_timeout` means different things in different transports.
		const hits = new Set<string>();
		for (const sec of secs) for (const b of sec.bullets) if (bulletTerm(b) === want) hits.add(b.text);
		return hits.size === 1 ? bulletDoc([...hits][0]) : '';
	};
}

function bulletTerm(b: Bullet): string {
	return b.term
		.replace(/^<|>$/g, '')
		.replace(/\.\.\.$/, '')
		.replace(/^<|>$/g, '')
		.trim()
		.toLowerCase();
}

function headingWords(title: string): string[] {
	return title
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter(Boolean);
}

function anchor(title: string): string {
	return title
		.toLowerCase()
		.replace(/[`'"]/g, '')
		.replace(/[^a-z0-9_]+/g, '-')
		.replace(/_/g, '-')
		.replace(/^-+|-+$/g, '');
}

function trimSummary(s: string): string {
	const one = firstSentence(s);
	return one.length > 320 ? one.slice(0, 317).replace(/\s+\S*$/, '') + '…' : one;
}

const isIdent = (t: string | undefined) => !!t && /^[a-z][a-z0-9_]*$/i.test(t);

// ---------------------------------------------------------------------------
// Building directive-shaped schemas from syntax nodes

type BuildCtx = {
	docsUrl: string;
	category: DirectiveSchema['category'];
	lookup: (term: string) => string;
	path: string;
};

function newSchema(name: string, ctx: BuildCtx, summary: string): DirectiveSchema {
	return {
		name,
		summary,
		docsUrl: ctx.docsUrl,
		category: ctx.category,
		order: -1,
		matcher: false,
		args: [],
		examples: []
	};
}

function argsFor(tokens: string[], ctx: BuildCtx, fallbackDoc: string) {
	const parsed = parseArgs(tokens, (n) => ctx.lookup(`${n}`) || ctx.lookup(n.split('|')[0]), ctx.path);
	if (parsed.args.length === 1 && !parsed.args[0].doc) parsed.args[0].doc = fallbackDoc;
	return parsed;
}

function mergeArgs(a: ArgSchema[], b: ArgSchema[]): ArgSchema[] {
	if (!a.length) return b;
	if (!b.length) return a;
	return a.length >= b.length ? a : b;
}

/** Apply a syntax line (and its block) to `schema`. Returns the schema. */
function applyLine(schema: DirectiveSchema, node: SyntaxNode, ctx: BuildCtx): DirectiveSchema {
	const parsed = argsFor(node.tokens.slice(1), ctx, schema.summary);
	if (parsed.matcher) schema.matcher = true;
	if (parsed.block) schema.block = true;
	if (parsed.moduleTail && !node.children) {
		schema.block = true;
		schema.freeformBody = true;
	}
	const line = node.children ? `${node.text} {` : node.text;
	const syntax = (schema.syntax ??= []);
	if (!syntax.includes(line)) syntax.push(line);
	if (
		schema.args.length &&
		parsed.args.length &&
		JSON.stringify(schema.args) !== JSON.stringify(parsed.args)
	) {
		schema.forms ??= [schema.args];
		schema.forms.push(parsed.args);
		schema.args = mergeArgs(schema.args, parsed.args);
	} else if (parsed.args.length) {
		schema.args = parsed.args;
	}
	if (node.children) {
		schema.block = true;
		applyBody(schema, node.children, ctx);
	}
	return schema;
}

function applyBody(schema: DirectiveSchema, children: SyntaxNode[], ctx: BuildCtx) {
	for (const child of children) {
		const [t0] = child.tokens;
		if (t0 === undefined) continue;
		if (t0 === '<directives...>') {
			schema.allowsDirectives = true;
			continue;
		}
		if (t0.startsWith('@')) {
			schema.allowsResponseMatchers = true;
			continue;
		}
		if (t0 === '...' || (child.tokens.length === 1 && /^<.*\.\.\.>$/.test(t0)) || /^<any other/.test(t0)) {
			schema.freeformBody = true;
			continue;
		}
		const bracketIdent = /^\[([a-z_]+)\]$/i.exec(t0);
		if (t0.startsWith('<') || (t0.startsWith('[') && !bracketIdent) || /^[+\-?>~]/.test(t0)) {
			schema.freeformBody = true;
			const row = parseArgs(child.tokens, (n) => ctx.lookup(n), ctx.path).args;
			const rows = (schema.rows ??= []);
			if (!rows.some((r) => JSON.stringify(r) === JSON.stringify(row))) rows.push(row);
			continue;
		}
		const name = bracketIdent ? bracketIdent[1] : t0;
		const subs = (schema.subdirectives ??= {});
		const summary = trimSummary(ctx.lookup(name));
		const sub = subs[name] ?? newSchema(name, { ...ctx }, summary);
		sub.docsUrl = `${ctx.docsUrl.split('#')[0]}#${name}`;
		if (!sub.summary) sub.summary = summary;
		subs[name] = sub;
		applyLine(
			sub,
			{ ...child, tokens: [name, ...child.tokens.slice(1)] },
			{ ...ctx, path: `${ctx.path}/${name}` }
		);
	}
}

/** Depth-first search for a subdirective by name. Returns the path of names. */
function findSub(schema: DirectiveSchema, name: string, path: string[] = []): string[] | null {
	const subs = schema.subdirectives ?? {};
	if (subs[name]) return [...path, name];
	for (const [k, v] of Object.entries(subs)) {
		const hit = findSub(v, name, [...path, k]);
		if (hit) return hit;
	}
	return null;
}

function getPath(schema: DirectiveSchema, path: string[]): DirectiveSchema {
	let cur = schema;
	for (const p of path) cur = cur.subdirectives![p];
	return cur;
}

function examplesFrom(secs: Section[], from: number): string[] {
	const out: string[] = [];
	for (let i = from; i < secs.length; i++) {
		for (const cb of secs[i].codeBlocks)
			if (cb.lang === 'caddy' || cb.lang === 'caddy-d') out.push(cb.text.trimEnd());
	}
	return out;
}

// ---------------------------------------------------------------------------
// Directives

function readDirectiveTable(docs: Docs): { summaries: Record<string, string>; order: string[] } {
	const md = docs.read('caddyfile/directives.md');
	const summaries: Record<string, string> = {};
	for (const m of md.matchAll(/^\*\*\[([a-z_]+)\]\([^)]*\)\*\*\s*\|\s*(.+)$/gm))
		summaries[m[1]] = cleanInline(m[2]);
	const secs = sections(md);
	const orderSec = secs[findSection(secs, (s) => /^Directive order$/i.test(s.title))];
	const block = orderSec.codeBlocks.find((c) => c.lang === 'caddy-d');
	if (!block) throw new Error('directives.md: no default order block');
	const order = block.text
		.split('\n')
		.map((l) => l.replace(/#.*/, '').trim())
		.filter(Boolean);
	return { summaries, order };
}

function variantBlocks(
	schema: DirectiveSchema,
	secs: Section[],
	skip: Set<number>,
	headingMap: Record<string, string>,
	baseUrl: string,
	category: DirectiveSchema['category']
) {
	// heading chain for each section
	const chain: string[][] = [];
	const stack: Section[] = [];
	for (const s of secs) {
		while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
		stack.push(s);
		chain.push(stack.map((x) => x.title));
	}
	secs.forEach((sec, i) => {
		if (skip.has(i)) return;
		for (const cb of sec.codeBlocks) {
			if (cb.lang !== 'caddy-d') continue;
			const nodes = parseSyntaxBlock(cb.text);
			const n = nodes[0];
			if (!n || nodes.length !== 1) continue;
			let hostPath: string[] | null = null;
			let module: string | undefined;
			let rest: string[] = [];
			if (n.tokens[0] === '...') {
				const mapped = chain[i].map((t) => headingMap[t]).find(Boolean);
				if (!mapped || !isIdent(n.tokens[1]) || !headingWords(sec.title).includes(n.tokens[1].toLowerCase()))
					continue;
				hostPath = mapped.split('/');
				module = n.tokens[1];
				rest = n.tokens.slice(2);
			} else {
				if (n.tokens[0] === schema.name) continue;
				hostPath = findSub(schema, n.tokens[0]);
				if (!hostPath) continue;
				const second = n.tokens[1];
				if (isIdent(second) && headingWords(sec.title).includes(second!.toLowerCase())) {
					module = second;
					rest = n.tokens.slice(2);
				} else if (second && /^<.*>$/.test(second) && n.children) {
					// Shared options for every module (e.g. `format <encoder_module> { … }`).
					const host = getPath(schema, hostPath);
					applyBody(host, n.children, {
						docsUrl: host.docsUrl,
						category,
						lookup: bulletLookup(secs, [i]),
						path: hostPath.join('/')
					});
					continue;
				} else continue;
			}
			const host = getPath(schema, hostPath);
			const variants = (host.variants ??= {});
			const ctx: BuildCtx = {
				docsUrl: `${baseUrl}#${anchor(sec.title)}`,
				category,
				lookup: bulletLookup(secs, [i]),
				path: `${hostPath.join('/')}/${module}`
			};
			const summary = trimSummary(sec.paragraphs[0] ?? '');
			const v = variants[module!] ?? newSchema(module!, ctx, summary);
			variants[module!] = v;
			applyLine(v, { ...n, tokens: [module!, ...rest] }, ctx);
		}
	});
}

/** `lb_policy` documents its policies as a nested bullet list: "- `cookie [<name> [<secret>]]` on the first request …". */
function nestedBulletVariants(schema: DirectiveSchema, md: string, sub: string) {
	const host = schema.subdirectives?.[sub];
	if (!host) return;
	const lines = md.split('\n');
	const start = lines.findIndex((l) => l.startsWith(`- **${sub}**`));
	if (start < 0) return;
	for (let i = start + 1; i < lines.length && !/^- \*\*/.test(lines[i]); i++) {
		const m = /^\s+- `([a-z_]+)((?:\s[^`]*)?)` (.*)$/.exec(lines[i]);
		if (!m) continue;
		const text = cleanInline(m[3]).replace(/^[a-z]/, (c) => c.toUpperCase());
		const v = newSchema(
			m[1],
			{ docsUrl: host.docsUrl, category: host.category, lookup: () => '', path: sub },
			trimSummary(text)
		);
		v.docsUrl = host.docsUrl;
		const toks = tokenize(m[2].trim());
		// docs write `query [key]` meaning an optional placeholder
		const fixed = toks.map((t) => (/^\[[a-z_]+\]$/.test(t) ? `[<${t.slice(1, -1)}>]` : t));
		v.args = parseArgs(fixed, () => '', `${sub}/${m[1]}`).args;
		v.syntax = [`${sub} ${m[1]}${m[2]}`.trim()];
		(host.variants ??= {})[m[1]] = v;
	}
}

const VARIANT_HEADINGS: Record<string, Record<string, string>> = {
	tls: {
		'Trust Pool Providers': 'client_auth/trust_pool',
		Issuers: 'issuer',
		'Certificate Managers': 'get_certificate'
	}
};

function buildDirective(
	docs: Docs,
	file: string,
	summaries: Record<string, string>,
	order: string[]
): DirectiveSchema {
	const md = docs.read(`caddyfile/directives/${file}`);
	const secs = sections(md);
	const titleIdx = findSection(secs, (s) => s.level === 1);
	const name = secs[titleIdx].title.trim();
	const docsUrl = `${SITE}/docs/caddyfile/directives/${name}`;
	const synIdx = findSection(secs, (s) => s.level === 2 && /^Syntax$/i.test(s.title));
	if (synIdx < 0) throw new Error(`${file}: no Syntax section`);
	const [synStart, synEnd] = regionOf(secs, synIdx);
	const exIdx = findSection(secs, (s) => s.level === 2 && /^Examples?$/i.test(s.title));
	const category = CATEGORIES[name] ?? 'misc';
	const preferred = Array.from({ length: synEnd - synStart }, (_, k) => synStart + k);
	const ctx: BuildCtx = { docsUrl, category, lookup: bulletLookup(secs, preferred), path: name };
	const intro = secs[titleIdx].paragraphs[0] ?? '';
	const schema = newSchema(name, ctx, summaries[name] ?? trimSummary(intro));
	schema.order = order.indexOf(name);
	const skip = new Set<number>();
	for (let i = synStart; i < synEnd; i++) {
		for (const cb of secs[i].codeBlocks) {
			if (cb.lang !== 'caddy-d') continue;
			const nodes = parseSyntaxBlock(cb.text);
			const own = nodes.filter((n) => n.tokens[0] === name);
			if (!own.length) continue;
			skip.add(i);
			for (const n of own) applyLine(schema, n, ctx);
		}
	}
	if (exIdx >= 0) for (let i = exIdx; i < secs.length; i++) skip.add(i);
	variantBlocks(schema, secs, skip, VARIANT_HEADINGS[name] ?? {}, docsUrl, category);
	if (name === 'reverse_proxy') nestedBulletVariants(schema, md, 'lb_policy');
	schema.examples = exIdx >= 0 ? examplesFrom(secs, exIdx) : [];
	if (/⚠️\s*Experimental|<i>⚠️ Experimental<\/i>/i.test(md.slice(0, 3000))) schema.experimental = true;
	return schema;
}

// ---------------------------------------------------------------------------
// Matchers

/** CEL forms may span lines inside backticks; fold them onto one line. */
function joinBacktickLines(text: string): string {
	const out: string[] = [];
	let buf = '';
	for (const line of text.split('\n')) {
		buf = buf ? `${buf} ${line.trim()}` : line;
		if ((buf.match(/`/g) ?? []).length % 2 === 0) {
			out.push(buf);
			buf = '';
		}
	}
	if (buf) out.push(buf);
	return out.join('\n');
}

function buildMatchers(docs: Docs): { matchers: Record<string, MatcherSchema>; headings: string[] } {
	const md = docs.read('caddyfile/matchers.md');
	const secs = sections(md);
	const std = findSection(secs, (s) => s.level === 2 && /^Standard matchers$/i.test(s.title));
	const [, end] = regionOf(secs, std);
	const matchers: Record<string, MatcherSchema> = {};
	const headings: string[] = [];
	for (let i = std + 1; i < end; i++) {
		const sec = secs[i];
		if (sec.level !== 3) continue;
		const name = sec.title.trim();
		headings.push(name);
		const [rs, re] = regionOf(secs, i);
		const preferred = Array.from({ length: re - rs }, (_, k) => rs + k);
		const lookup = bulletLookup(secs, preferred);
		const docsUrl = `${SITE}/docs/caddyfile/matchers#${anchor(name)}`;
		const holder = newSchema(name, { docsUrl, category: 'misc', lookup, path: `matcher:${name}` }, '');
		let celForm = '';
		const block = sec.codeBlocks.find((c) => c.lang === 'caddy-d');
		const syntax: string[] = [];
		if (block) {
			for (const n of parseSyntaxBlock(joinBacktickLines(block.text))) {
				if (n.tokens[0] === 'expression') {
					celForm ||= n.text.replace(/^expression\s+/, '');
					syntax.push(n.text);
				} else if (n.tokens[0] === name) {
					applyLine(holder, n, { docsUrl, category: 'misc', lookup, path: `matcher:${name}` });
				}
			}
		}
		const examples: string[] = [];
		for (let k = i + 1; k < re; k++) for (const cb of secs[k].codeBlocks) examples.push(cb.text.trimEnd());
		const m: MatcherSchema = {
			name,
			args: holder.args,
			celForm,
			docsUrl,
			summary: trimSummary(sec.paragraphs[0] ?? ''),
			syntax: [...(holder.syntax ?? []), ...syntax],
			examples
		};
		if (holder.block) m.blockForm = true;
		if (holder.subdirectives) m.subdirectives = holder.subdirectives;
		if (holder.forms) m.forms = holder.forms;
		matchers[name] = m;
	}
	return { matchers, headings };
}

function buildResponseMatchers(docs: Docs): Record<string, MatcherSchema> {
	const md = docs.read('caddyfile/response-matchers.md');
	const secs = sections(md);
	const idx = findSection(secs, (s) => s.level === 2 && /^Matchers$/i.test(s.title));
	const [, end] = regionOf(secs, idx);
	const out: Record<string, MatcherSchema> = {};
	for (let i = idx + 1; i < end; i++) {
		const sec = secs[i];
		if (sec.level !== 3) continue;
		const name = sec.title.trim();
		const lookup = bulletLookup(secs, [i]);
		const docsUrl = `${SITE}/docs/caddyfile/response-matchers#${anchor(name)}`;
		const holder = newSchema(name, { docsUrl, category: 'misc', lookup, path: `response:${name}` }, '');
		const block = sec.codeBlocks.find((c) => c.lang === 'caddy-d');
		if (block)
			for (const n of parseSyntaxBlock(block.text))
				if (n.tokens[0] === name) applyLine(holder, n, { docsUrl, category: 'misc', lookup, path: name });
		const [, re] = regionOf(secs, i);
		const examples: string[] = [];
		for (let k = i + 1; k < re; k++) for (const cb of secs[k].codeBlocks) examples.push(cb.text.trimEnd());
		out[name] = {
			name,
			args: holder.args,
			celForm: '',
			docsUrl,
			summary: trimSummary(sec.paragraphs[0] ?? ''),
			syntax: holder.syntax,
			examples
		};
	}
	return out;
}

// ---------------------------------------------------------------------------
// Global options

export type OptionHeadings = {
	top: string[];
	servers: string[];
	pki: string[];
	events: string[];
	nested: Record<string, string[]>;
};

function buildGlobalOptions(docs: Docs): {
	options: Record<string, GlobalOptionSchema>;
	headings: OptionHeadings;
} {
	const md = docs.read('caddyfile/options.md');
	const secs = sections(md);
	const baseUrl = `${SITE}/docs/caddyfile/options`;
	const headings: OptionHeadings = { top: [], servers: [], pki: [], events: [], nested: {} };

	// Doc text per option heading, scoped by h2 group.
	type HeadDoc = { group: string; name: string; idx: number; parent?: string };
	const heads: HeadDoc[] = [];
	let group = '';
	let lastL5 = '';
	secs.forEach((s, idx) => {
		if (s.level <= 2) group = s.title;
		const m = /^`?([a-z0-9_]+)`?$/i.exec(s.title.trim());
		if (s.level === 5 && m) {
			lastL5 = m[1];
			heads.push({ group, name: m[1], idx });
		} else if (s.level === 6 && m) {
			heads.push({ group, name: m[1], idx, parent: lastL5 });
		}
	});
	const docOf = (h: HeadDoc | undefined) => {
		if (!h) return '';
		const s = secs[h.idx];
		return trimSummary(s.paragraphs[0] ?? (s.bullets[0] ? `${s.bullets[0].term} ${s.bullets[0].text}` : ''));
	};
	const findHead = (grp: RegExp, name: string, parent?: string) =>
		heads.find(
			(h) => grp.test(h.group) && h.name === name && (parent === undefined ? !h.parent : h.parent === parent)
		);

	const qrIdx = findSection(secs, (s) => s.level === 1 && /^Global options$/i.test(s.title));
	const qr = secs[qrIdx].codeBlocks.find((c) => c.text.includes('# General Options'));
	if (!qr) throw new Error('options.md: quick reference block not found');
	const root = parseSyntaxBlock(qr.text)[0];
	const options: Record<string, GlobalOptionSchema> = {};
	const allBullets = bulletLookup(secs, []);
	const holder = newSchema(
		'(global)',
		{ docsUrl: baseUrl, category: 'global', lookup: allBullets, path: 'global' },
		''
	);
	applyBody(holder, root.children ?? [], {
		docsUrl: baseUrl,
		category: 'global',
		lookup: allBullets,
		path: 'global'
	});
	Object.assign(options, holder.subdirectives);

	const servers = options.servers;
	const setDoc = (schema: DirectiveSchema, h: HeadDoc | undefined, name: string) => {
		if (h) {
			const d = docOf(h);
			if (d) schema.summary = d;
		}
		schema.docsUrl = `${baseUrl}#${anchor(name)}`;
	};
	for (const [name, opt] of Object.entries(options)) {
		setDoc(
			opt,
			findHead(/General|TLS/, name) ?? (servers?.subdirectives?.[name] ? undefined : findHead(/./, name)),
			name
		);
		opt.order = -1;
	}
	for (const h of heads) {
		if (/General|TLS/.test(h.group) && !h.parent) headings.top.push(h.name);
		if (/Server/.test(h.group) && !h.parent) headings.servers.push(h.name);
		if (/PKI/.test(h.group) && !h.parent) headings.pki.push(h.name);
		if (/Event/.test(h.group) && !h.parent) headings.events.push(h.name);
		if (h.parent) (headings.nested[h.parent] ??= []).push(h.name);
	}
	for (const [name, sub] of Object.entries(servers?.subdirectives ?? {}))
		setDoc(sub, findHead(/Server/, name), name);
	// timeouts' children are documented as bullets in the timeouts section
	const tHead = findHead(/Server/, 'timeouts');
	if (tHead && servers?.subdirectives?.timeouts?.subdirectives) {
		const lk = bulletLookup(secs, [tHead.idx]);
		for (const [n, s] of Object.entries(servers.subdirectives.timeouts.subdirectives))
			s.summary = trimSummary(lk(n)) || s.summary;
	}
	const ca = options.pki?.subdirectives?.ca;
	for (const [name, sub] of Object.entries(ca?.subdirectives ?? {})) setDoc(sub, findHead(/PKI/, name), name);
	const on = options.events?.subdirectives?.on;
	if (on) setDoc(on, findHead(/Event/, 'on'), 'on');
	const fsIdx = findSection(secs, (s) => s.level === 2 && /^File Systems$/i.test(s.title));
	if (options.filesystem && fsIdx >= 0) {
		options.filesystem.summary = trimSummary(secs[fsIdx].paragraphs[0] ?? '');
		options.filesystem.docsUrl = `${baseUrl}#file-systems`;
	}

	// Level-6 headings under a free-form option become its subdirectives (listener_wrappers → tls, http_redirect, proxy_protocol).
	for (const h of heads.filter((x) => x.parent)) {
		const parentPath = findSub(holder, h.parent!);
		if (!parentPath) continue;
		const parent = getPath(holder, parentPath);
		if (!parent.freeformBody) continue;
		const ctx: BuildCtx = {
			docsUrl: `${baseUrl}#${anchor(h.name)}`,
			category: 'global',
			lookup: bulletLookup(secs, [h.idx]),
			path: `${parentPath.join('/')}/${h.name}`
		};
		const sub = newSchema(h.name, ctx, docOf(h));
		const block = secs[h.idx].codeBlocks.find((c) => c.lang === 'caddy-d');
		const node = block ? parseSyntaxBlock(block.text).find((n) => n.tokens[0] === h.name) : undefined;
		applyLine(sub, node ?? { text: h.name, tokens: [h.name] }, ctx);
		(parent.subdirectives ??= {})[h.name] = sub;
	}

	// Module variants documented in their own blocks (e.g. `trusted_proxies static …`).
	const qrSet = new Set<number>([qrIdx]);
	variantBlocks(holder, secs, qrSet, {}, baseUrl, 'global');

	// Examples per option: code blocks inside its heading region.
	for (const h of heads) {
		const [s, e] = regionOf(secs, h.idx);
		const ex: string[] = [];
		for (let k = s; k < e; k++)
			for (const cb of secs[k].codeBlocks) if (cb.lang === 'caddy') ex.push(cb.text.trimEnd());
		if (!ex.length) continue;
		const path = h.parent
			? findSub(holder, h.name)
			: /Server/.test(h.group)
				? ['servers', h.name]
				: /PKI/.test(h.group)
					? ['pki', 'ca', h.name]
					: /Event/.test(h.group)
						? ['events', h.name]
						: [h.name];
		try {
			const target = path ? getPath(holder, path) : undefined;
			if (target && !target.examples.length) target.examples = ex;
		} catch {
			/* heading without a matching option; coverage test reports it */
		}
	}
	return { options: holder.subdirectives ?? {}, headings };
}

// ---------------------------------------------------------------------------
// Placeholders

function buildPlaceholders(docs: Docs): PlaceholderSchema[] {
	const out = new Map<string, PlaceholderSchema>();
	const add = (p: PlaceholderSchema) => {
		const prev = out.get(p.name);
		if (prev) {
			out.set(p.name, {
				...prev,
				...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== ''))
			});
		} else out.set(p.name, p);
	};
	const param = (n: string) => /\*|<|\bN\b/.test(n);
	// Shorthands (concepts.md)
	const concepts = docs.read('caddyfile/concepts.md');
	for (const m of concepts.matchAll(/^\|\s*`(\{[^`]+\})`\s*\|\s*`(\{[^`]+\})`\s*\|/gm)) {
		const [, short, long] = m;
		add({
			name: short,
			longForm: long,
			doc: `Shorthand for ${long}.`,
			scope: scopeOf(long),
			...(param(short) ? { parameterized: true } : {})
		});
		add({
			name: long,
			shorthand: short,
			doc: '',
			scope: scopeOf(long),
			...(param(long) ? { parameterized: true } : {})
		});
	}
	// Tables and bullets elsewhere: `{x}` | description, or - `{x}` description
	const files: [string, PlaceholderSchema['scope'] | null][] = [
		['conventions.md', 'global'],
		...docs.list('caddyfile/directives').map((f) => [`caddyfile/directives/${f}`, null] as [string, null]),
		['caddyfile/matchers.md', 'matcher']
	];
	for (const [file, scope] of files) {
		const md = docs.read(file);
		const rows = [
			...md.matchAll(/^\|?\s*`(\{[a-z_%?][^`\s]*\})`\s*\|\s*(.+?)\s*\|?\s*$/gim),
			...md.matchAll(/^\s*- `(\{[a-z_%?][^`\s]*\})`:?\s+(.+)$/gim)
		];
		for (const m of rows) {
			const name = m[1];
			if (/^\{\$/.test(name)) continue;
			// Rows of a "where:" explanation (import.md, matchers.md) describe syntax, not placeholders.
			if (/^(where|without)\b/i.test(cleanInline(m[2]))) continue;
			add({
				name,
				doc: cleanInline(m[2]),
				scope: scope ?? scopeOf(name),
				...(param(name) ? { parameterized: true } : {})
			});
		}
	}
	for (const p of EXTRA_PLACEHOLDERS) add(p);
	// Fill empty docs on long forms from their shorthand's description.
	for (const p of out.values()) {
		if (!p.doc && p.shorthand) {
			const s = out.get(p.shorthand);
			if (s?.doc && !s.doc.startsWith('Shorthand')) p.doc = s.doc;
		}
		if (!p.doc) p.doc = p.shorthand ? `Long form of ${p.shorthand}.` : '';
	}
	return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scopeOf(name: string): PlaceholderSchema['scope'] {
	if (/^\{(http\.reverse_proxy|rp)\./.test(name) || name === '{upstream_hostport}') return 'reverse_proxy';
	if (/^\{(http\.error|err)\./.test(name)) return 'error';
	if (/^\{(env|system|time|file)\./.test(name)) return 'global';
	if (/^\{(re|http\.regexp|file_match|http\.matchers)\b/.test(name)) return 'matcher';
	if (/^\{tls_/.test(name) || /^\{http\.request\.tls/.test(name)) return 'tls';
	if (/^\{args/.test(name) || name === '{block}') return 'snippet';
	return 'http';
}

// ---------------------------------------------------------------------------

export type ExtractResult = {
	bundle: SchemaBundle;
	/** Names the docs list, for the coverage test. */
	docsIndex: {
		directives: string[];
		matcherHeadings: string[];
		matcherTokenHeadings: string[];
		responseMatcherHeadings: string[];
		options: OptionHeadings;
		quickReferenceOptions: string[];
	};
};

export function extract(docs: Docs, source: SchemaSource): ExtractResult {
	const { summaries, order } = readDirectiveTable(docs);
	const directives: Record<string, DirectiveSchema> = {};
	for (const f of docs.list('caddyfile/directives')) {
		const d = buildDirective(docs, f, summaries, order);
		directives[d.name] = d;
	}
	const { matchers, headings } = buildMatchers(docs);
	const responseMatchers = buildResponseMatchers(docs);
	const { options, headings: optionHeadings } = buildGlobalOptions(docs);
	const placeholders = buildPlaceholders(docs);

	const matcherMd = sections(docs.read('caddyfile/matchers.md'));
	const tokenHeadings = matcherMd
		.filter((s) => s.level === 3 && /matchers$/i.test(s.title) && !/Standard/i.test(s.title))
		.map((s) => s.title);
	const matcherTokenForms: MatcherTokenForm[] = MATCHER_TOKEN_FORMS;

	const bundle: SchemaBundle = {
		schemaVersion: SCHEMA_VERSION,
		source,
		directives,
		matchers,
		responseMatchers,
		matcherTokenForms,
		globalOptions: options,
		defaultOrder: order,
		placeholders
	};
	applyOverrides(bundle);
	return {
		bundle,
		docsIndex: {
			directives: Object.keys(summaries).sort(),
			matcherHeadings: headings,
			matcherTokenHeadings: tokenHeadings,
			responseMatcherHeadings: Object.keys(responseMatchers),
			options: optionHeadings,
			quickReferenceOptions: Object.keys(options).sort()
		}
	};
}

export type { CodeBlock };
export { normaliseArgName };
