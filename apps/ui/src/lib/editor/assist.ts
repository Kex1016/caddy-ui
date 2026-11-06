/**
 * Autocomplete and hover docs for the Caddyfile editor, from W2's schema: directive, subdirective,
 * global option and matcher names for the scope at the cursor, enum values and keywords for
 * arguments, named matchers defined in the block, and the placeholder catalogue after `{`.
 */
import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSource
} from '@codemirror/autocomplete';
import { hoverTooltip, type Tooltip } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { ArgSchema, DirectiveSchema, MatcherSchema, SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { cursorContext, findPlaceholder, schemaFor, type Scope } from './context';

type Named = { name: string; summary?: string; docsUrl?: string; syntax?: string[]; experimental?: boolean };

const SAFE_URL = /^https:\/\/caddyserver\.com\//;

/** Plain-DOM info panel for a completion or hover: summary, syntax lines and a link to Caddy's docs. */
export function docNode(item: Named, kindLabel?: string): HTMLElement {
	const el = document.createElement('div');
	el.className = 'cf-doc';
	const head = document.createElement('div');
	head.className = 'cf-doc__head';
	const name = document.createElement('code');
	name.textContent = item.name;
	head.append(name);
	if (kindLabel) {
		const k = document.createElement('span');
		k.className = 'cf-doc__kind';
		k.textContent = kindLabel + (item.experimental ? ' · experimental' : '');
		head.append(k);
	}
	el.append(head);
	if (item.summary) {
		const p = document.createElement('p');
		p.textContent = item.summary;
		el.append(p);
	}
	if (item.syntax?.length) {
		const pre = document.createElement('pre');
		pre.textContent = item.syntax.slice(0, 8).join('\n');
		el.append(pre);
	}
	if (item.docsUrl && SAFE_URL.test(item.docsUrl)) {
		const a = document.createElement('a');
		a.href = item.docsUrl;
		a.target = '_blank';
		a.rel = 'noreferrer noopener';
		a.textContent = 'Caddy docs';
		el.append(a);
	}
	return el;
}

function option(item: Named, type: string, detail: string, boost = 0): Completion {
	return { label: item.name, type, detail, boost, info: () => docNode(item, detail) };
}

/** Names that may start a line in a scope. */
export function lineStartOptions(schema: SchemaBundle, scope: Scope): Completion[] {
	switch (scope.kind) {
		case 'directives': {
			const out = Object.values(schema.directives)
				.filter((d) => !d.onlyIn)
				.map((d) => option(d, 'keyword', d.category));
			out.push({ label: '@', type: 'keyword', detail: 'named matcher', apply: '@', boost: -1 });
			return out;
		}
		case 'global':
			return Object.values(schema.globalOptions).map((g) => option(g, 'keyword', 'global option'));
		case 'sub': {
			const subs = Object.values(scope.owner.subdirectives ?? {}).map((s) =>
				option(s, 'property', 'subdirective')
			);
			return subs;
		}
		case 'matchers':
			return Object.values(schema.matchers).map((m) => option(m as Named, 'function', 'matcher'));
		case 'top':
			return [{ label: 'import', type: 'keyword', detail: 'import a snippet or file' }];
		default:
			return [];
	}
}

/** Values the schema lists for an argument: enum values and keywords. */
function argValues(a: ArgSchema | undefined): string[] {
	if (!a) return [];
	return [...(a.enum ?? []), ...(a.literals ?? [])];
}

/** Argument completions for token `index` (0 = first argument) of a directive or matcher. */
export function argumentOptions(
	node: DirectiveSchema | MatcherSchema,
	index: number,
	ctx: { matcherNames: string[]; acceptsMatcher: boolean }
): Completion[] {
	const out = new Map<string, Completion>();
	const add = (label: string, type: string, detail: string, boost = 0) => {
		if (!out.has(label)) out.set(label, { label, type, detail, boost });
	};
	if (ctx.acceptsMatcher && index === 0) {
		for (const m of ctx.matcherNames) add(m, 'variable', 'named matcher', 2);
		add('*', 'variable', 'all requests', 1);
	}
	const forms = 'forms' in node && node.forms?.length ? node.forms : [node.args];
	for (const form of forms) {
		// The matcher is optional, so with one the argument sits one token later.
		for (const k of ctx.acceptsMatcher ? [index, index - 1] : [index]) {
			const a = form[k] ?? (form.at(-1)?.variadic && k >= form.length ? form.at(-1) : undefined);
			for (const v of argValues(a)) add(v, 'enum', a?.name ?? '');
		}
	}
	if (index === 0 && 'variants' in node && node.variants) {
		for (const v of Object.values(node.variants)) add(v.name, 'enum', 'module');
	}
	return [...out.values()];
}

/** The autocomplete source; `getSchema` returns null until the schema has loaded. */
export function caddyfileCompletion(getSchema: () => SchemaBundle | null): CompletionSource {
	return (cx: CompletionContext): CompletionResult | null => {
		const schema = getSchema();
		if (!schema) return null;
		const text = cx.state.doc.toString();
		const pos = cx.pos;
		const lineText = cx.state.doc.lineAt(pos).text.slice(0, pos - cx.state.doc.lineAt(pos).from);
		if (/(^|\s)#/.test(lineText)) return null; // inside a comment

		// Placeholders anywhere in a token: `{` up to the cursor.
		const ph = /\{[^\s{}]*$/.exec(lineText);
		if (ph) {
			const from = pos - ph[0].length;
			return {
				from,
				options: schema.placeholders.map((p) => ({
					label: p.name,
					type: 'variable',
					detail: p.scope,
					info: () =>
						docNode(
							{ name: p.name, summary: p.doc + (p.shorthand ? ` Shorthand: ${p.shorthand}.` : '') },
							'placeholder'
						)
				})),
				// Replace the `}` that closeBrackets typed after the cursor, so `{ho` + `}` becomes `{host}`.
				to: cx.state.sliceDoc(pos, pos + 1) === '}' ? pos + 1 : pos
			};
		}

		const c = cursorContext(schema, text, pos);
		if (c.before.length === 0) {
			if (!c.word && !cx.explicit) return null;
			const options = lineStartOptions(schema, c.scope);
			return options.length ? { from: c.wordFrom, options, validFor: /^[\w@-]*$/ } : null;
		}

		const first = c.before[0] as string;
		// `@name <matcher> …` on a definition line: the matcher module comes first.
		if (first.startsWith('@') && c.scope.kind !== 'matchers' && c.scope.kind !== 'sub') {
			if (c.before.length === 1) {
				const options = Object.values(schema.matchers).map((m) => option(m as Named, 'function', 'matcher'));
				return { from: c.wordFrom, options, validFor: /^[\w-]*$/ };
			}
			const m = schema.matchers[c.before[1] as string];
			if (!m) return null;
			const options = argumentOptions(m, c.before.length - 2, { matcherNames: [], acceptsMatcher: false });
			return options.length ? { from: c.wordFrom, options } : null;
		}

		const found = schemaFor(schema, c.scope, first);
		if (!found) return null;
		const acceptsMatcher = found.kind !== 'matcher' && found.node.matcher === true;
		let node: DirectiveSchema | MatcherSchema = found.node;
		let index = c.before.length - 1;
		// Inside a module variant (`transport http`, `lb_policy cookie`), complete the variant's arguments.
		if (found.kind !== 'matcher' && found.node.variants && c.before.length >= 2) {
			const variant = found.node.variants[c.before[1] as string];
			if (variant) {
				node = variant;
				index = c.before.length - 2;
			}
		}
		const options = argumentOptions(node, index, {
			matcherNames: c.matcherNames,
			acceptsMatcher: acceptsMatcher && node === found.node
		});
		if (!options.length) return null;
		return { from: c.wordFrom, options, validFor: /^[\w@*/.-]*$/ };
	};
}

/** Hover docs for directives, subdirectives, global options, matchers and placeholders. */
export function caddyfileHover(getSchema: () => SchemaBundle | null): Extension {
	return hoverTooltip((view, pos): Tooltip | null => {
		const schema = getSchema();
		if (!schema) return null;
		const line = view.state.doc.lineAt(pos);
		const t = line.text;
		const at = pos - line.from;
		// The whitespace-delimited word under the pointer.
		let s = at;
		let e = at;
		while (s > 0 && !/\s/.test(t[s - 1] as string)) s--;
		while (e < t.length && !/\s/.test(t[e] as string)) e++;
		if (s === e) return null;
		const word = t.slice(s, e);
		const before = t.slice(0, s);
		if (/(^|\s)#/.test(before) || word.startsWith('#')) return null;

		// A placeholder inside the word.
		for (const m of word.matchAll(/\{[^\s{}]+\}/g)) {
			const from = s + (m.index ?? 0);
			const to = from + m[0].length;
			if (at >= from && at <= to) {
				const p = findPlaceholder(schema, m[0]);
				if (!p) return null;
				return tooltip(
					line.from + from,
					line.from + to,
					{ name: m[0], summary: p.doc },
					p.name === m[0] ? 'placeholder' : `placeholder ${p.name}`
				);
			}
		}

		const c = cursorContext(schema, view.state.doc.toString(), line.from + s);
		const pos0 = line.from + s;
		const pos1 = line.from + e;
		if (c.before.length === 0) {
			const found = schemaFor(schema, c.scope, word);
			if (!found) return null;
			const label = found.kind === 'option' ? 'global option' : found.kind;
			return tooltip(pos0, pos1, found.node as Named, label);
		}
		// The matcher module on a `@name path …` line, or a module variant (`transport http`).
		const first = c.before[0] as string;
		if (c.before.length === 1 && first.startsWith('@')) {
			const m = schema.matchers[word];
			return m ? tooltip(pos0, pos1, m as Named, 'matcher') : null;
		}
		if (c.before.length === 1) {
			const found = schemaFor(schema, c.scope, first);
			if (found && found.kind !== 'matcher') {
				const v = found.node.variants?.[word];
				if (v) return tooltip(pos0, pos1, v, `${first} module`);
			}
		}
		return null;
	});
}

function tooltip(from: number, to: number, item: Named, label: string): Tooltip {
	return { pos: from, end: to, above: true, create: () => ({ dom: docNode(item, label) }) };
}
