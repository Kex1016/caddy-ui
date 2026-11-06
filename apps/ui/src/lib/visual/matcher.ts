/**
 * Named matcher definitions as a small model the matcher builder edits:
 *
 *   @name path /a /b                  → inline form, one module
 *   @name { path /a  header X y }     → block form, modules AND'ed
 *   @name `expr`                      → CEL shorthand
 *   @name not { … } / @name not path /x
 *
 * Reading and writing go through W1's nodes, so comments inside a block form survive.
 */
import {
	createCelMatcherDef,
	createDirective,
	createToken,
	isCelShorthand,
	nodesFromText,
	printNodes,
	type Directive,
	type MatcherDef,
	type Node
} from '@caddy-ui/caddyfile';
import type { MatcherSchema, SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { replaceArgs } from './forms/node';

export type MatcherModule = {
	/** Module name: `path`, `header`, `not`, `expression`, … */
	name: string;
	args: string[];
	/** `not { … }` and `file { … }` carry a block; kept as nodes so unknown content survives. */
	body?: Node[];
};

export type MatcherForm = 'inline' | 'block' | 'cel';

export type MatcherSetModel = {
	name: string;
	form: MatcherForm;
	modules: MatcherModule[];
	/** The CEL expression for the shorthand form. */
	cel?: string;
};

function moduleOf(d: Directive): MatcherModule {
	const m: MatcherModule = { name: d.name.text, args: d.args.map((a) => a.text) };
	if (d.body) m.body = d.body;
	return m;
}

export function readMatcherDef(def: MatcherDef): MatcherSetModel {
	const name = def.name.text;
	if (def.inline && isCelShorthand(def)) return { name, form: 'cel', modules: [], cel: def.inline.name.text };
	if (def.inline) return { name, form: 'inline', modules: [moduleOf(def.inline)] };
	const modules = (def.body ?? []).filter((n): n is Directive => n.kind === 'directive').map(moduleOf);
	return { name, form: 'block', modules };
}

/** Write the model back onto the definition, keeping existing module lines (and their comments) in place. */
export function writeMatcherDef(def: MatcherDef, model: MatcherSetModel): void {
	const name = model.name.startsWith('@') ? model.name : '@' + model.name;
	if (def.name.text !== name) {
		const fresh = createToken(name);
		def.name.text = fresh.text;
		def.name.raw = fresh.raw;
		def.name.quote = fresh.quote;
		delete def.name.span;
	}
	if (model.form === 'cel') {
		const made = createCelMatcherDef(name, model.cel ?? '');
		def.inline = made.inline;
		delete def.body;
		clearBraces(def);
		return;
	}
	const form: MatcherForm = model.form === 'inline' && model.modules.length !== 1 ? 'block' : model.form;
	if (form === 'inline') {
		const m = model.modules[0]!;
		const existing = def.inline && !isCelShorthand(def) ? def.inline : undefined;
		const line = existing ?? createDirective(m.name, m.args);
		if (existing) {
			if (existing.name.text !== m.name) {
				const t = createToken(m.name);
				existing.name = t;
			}
			replaceArgs(existing, m.args);
		}
		if (m.body) line.body = m.body;
		else delete line.body;
		def.inline = line;
		delete def.body;
		if (!m.body) clearBraces(def);
		return;
	}
	// block form
	const existing = def.body ?? (def.inline && !isCelShorthand(def) ? [def.inline] : []);
	const lines = existing.filter((n): n is Directive => n.kind === 'directive');
	const others = existing.filter((n) => n.kind !== 'directive');
	const out: Node[] = [];
	model.modules.forEach((m, i) => {
		const line = lines[i];
		if (line) {
			if (line.name.text !== m.name) line.name = createToken(m.name);
			replaceArgs(line, m.args);
			if (m.body) line.body = m.body;
			else delete line.body;
			out.push(line);
		} else {
			const d = createDirective(m.name, m.args);
			if (m.body) d.body = m.body;
			out.push(d);
		}
	});
	def.body = [...out, ...others];
	delete def.inline;
	if (def.layout) {
		delete def.layout.braceStyle;
		delete def.layout.braceGap;
	}
}

function clearBraces(def: MatcherDef): void {
	if (!def.layout) return;
	delete def.layout.braceLeading;
	delete def.layout.braceStyle;
	delete def.layout.braceGap;
	delete def.layout.innerTrivia;
	delete def.layout.closeIndent;
	delete def.layout.closeTrailing;
	delete def.layout.closeNewline;
}

/** The Caddyfile text a model produces, for the builder's preview. */
export function matcherPreview(model: MatcherSetModel): string {
	const def: MatcherDef = {
		kind: 'matcher',
		name: createToken('@' + model.name.replace(/^@/, '')),
		trivia: []
	};
	writeMatcherDef(def, model);
	return printNodes([def]).trimEnd();
}

/** Nested modules of a `not { … }` block. */
export function nestedModules(m: MatcherModule): MatcherModule[] {
	if (m.name === 'not') {
		if (m.body) return m.body.filter((n): n is Directive => n.kind === 'directive').map(moduleOf);
		if (m.args.length) return [{ name: m.args[0]!, args: m.args.slice(1) }];
	}
	return [];
}

/** Parse matcher module lines typed as text (`path /a`, `header X y`). */
export function modulesFromText(text: string): MatcherModule[] {
	return nodesFromText(text, { directives: false })
		.filter((n): n is Directive => n.kind === 'directive')
		.map(moduleOf);
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * The CEL equivalent of a module, from the schema's `celForm` (`path('<paths...>')`,
 * `header({'<field>': '<value>'})`), with the arguments filled in.
 */
export function celOf(schema: SchemaBundle | null, m: MatcherModule): string {
	if (m.name === 'expression') return m.args.join(' ');
	if (m.name === 'not') {
		const inner = nestedModules(m)
			.map((x) => celOf(schema, x))
			.filter(Boolean);
		return inner.length ? `!(${inner.join(' && ')})` : '!(…)';
	}
	const s: MatcherSchema | undefined = schema?.matchers[m.name];
	if (!s?.celForm) return `${m.name}(${m.args.map(quote).join(', ')})`;
	let form = s.celForm;
	// `<paths...>` style variadics take every remaining argument; `<name>` takes the next one.
	const args = [...m.args];
	const named = [...form.matchAll(/<([a-z_]+)(\.\.\.)?>/g)];
	named.forEach((hit, i) => {
		const rest = named.length - i - 1;
		const take = hit[2] ? Math.max(0, args.length - rest) : 1;
		const vals = args.splice(0, take);
		const text = vals.map((v) => v.replace(/'/g, "\\'")).join("', '");
		form = form.replace(hit[0], text);
	});
	return form;
}

/** The CEL for a whole set (modules AND'ed). */
export function celOfSet(schema: SchemaBundle | null, model: MatcherSetModel): string {
	if (model.form === 'cel') return model.cel ?? '';
	const parts = model.modules.map((m) => celOf(schema, m));
	return parts.length > 1 ? parts.map((p) => `(${p})`).join(' && ') : (parts[0] ?? '');
}

/** Names of the matcher modules a builder can offer, standard ones first. */
export function matcherModuleNames(schema: SchemaBundle | null): string[] {
	const names = Object.keys(schema?.matchers ?? {});
	const first = ['path', 'path_regexp', 'host', 'header', 'method', 'not', 'expression'];
	return [...first.filter((n) => names.includes(n)), ...names.filter((n) => !first.includes(n)).sort()];
}

/** Named matchers (`@name`) defined directly in a body and in its container children, in file order. */
export function matcherNamesIn(body: readonly Node[]): string[] {
	const out: string[] = [];
	const visit = (nodes: readonly Node[]) => {
		for (const n of nodes) {
			if (n.kind === 'matcher') out.push(n.name.text);
			else if (n.kind === 'directive' && n.body && CONTAINER_NAMES.has(n.name.text)) visit(n.body);
		}
	};
	visit(body);
	return [...new Set(out)];
}

const CONTAINER_NAMES = new Set(['handle', 'route', 'handle_errors', 'handle_path']);

/** Capture groups of a regexp (unnamed count and named groups), for `{re.name.N}` suggestions. */
export function captureGroups(regexp: string): { count: number; names: string[] } {
	let count = 0;
	const names: string[] = [];
	for (let i = 0; i < regexp.length; i++) {
		const c = regexp[i];
		if (c === '\\') {
			i++;
			continue;
		}
		if (c === '[') {
			// skip a character class
			i++;
			while (i < regexp.length && regexp[i] !== ']') {
				if (regexp[i] === '\\') i++;
				i++;
			}
			continue;
		}
		if (c !== '(') continue;
		if (regexp[i + 1] !== '?') {
			count++;
			continue;
		}
		const named = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(regexp.slice(i));
		if (named) {
			count++;
			names.push(named[1]!);
		}
	}
	return { count, names };
}
