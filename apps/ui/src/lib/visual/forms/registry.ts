/**
 * Where forms are looked up. Bespoke forms register themselves by directive name; everything else falls
 * back to the schema-generated form, and names the schema does not know get the raw form.
 *
 * W5b adds forms by calling `registerForm(spec)` from `forms/directives/index.ts` (and matcher forms with
 * `registerMatcherForm`); nothing else needs to change.
 */
import type { DirectiveSchema, MatcherSchema, SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { genericForm, genericMatcherForm, unknownForm } from './generic';
import type { FormSpec } from './types';

/**
 * A form can be a plain spec or a factory that reads the schema (to borrow generic sub-fields, labels
 * and docs links). Factories are memoised per schema bundle.
 */
export type FormFactory = (schema: SchemaBundle | null) => FormSpec;
type Entry = { factory: FormFactory; cache: WeakMap<SchemaBundle, FormSpec>; bare?: FormSpec };

const directiveForms = new Map<string, Entry>();
const globalForms = new Map<string, Entry>();
const matcherForms = new Map<string, Entry>();

function entry(spec: FormSpec | FormFactory): Entry {
	return { factory: typeof spec === 'function' ? spec : () => spec, cache: new WeakMap() };
}

function build(e: Entry, schema: SchemaBundle | null): FormSpec {
	if (!schema) return (e.bare ??= e.factory(null));
	let spec = e.cache.get(schema);
	if (!spec) {
		spec = e.factory(schema);
		e.cache.set(schema, spec);
	}
	return spec;
}

export function registerForm(name: string, spec: FormSpec | FormFactory): void {
	directiveForms.set(name, entry(spec));
}

export function registerGlobalForm(name: string, spec: FormSpec | FormFactory): void {
	globalForms.set(name, entry(spec));
}

export function registerMatcherForm(name: string, spec: FormSpec | FormFactory): void {
	matcherForms.set(name, entry(spec));
}

export function hasBespokeForm(name: string): boolean {
	return directiveForms.has(name);
}

export function hasBespokeMatcherForm(name: string): boolean {
	return matcherForms.has(name);
}

const lookup = <T>(rec: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
	rec && Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined;

export type FormLookup = { spec: FormSpec; source: 'bespoke' | 'schema' | 'unknown' };

/** The form for a directive in a site-like body. */
export function formForDirective(schema: SchemaBundle | null, name: string): FormLookup {
	const bespoke = directiveForms.get(name);
	if (bespoke) return { spec: build(bespoke, schema), source: 'bespoke' };
	const s = lookup(schema?.directives, name);
	if (s) return { spec: genericForm(s), source: 'schema' };
	return { spec: unknownForm(name), source: 'unknown' };
}

/** The form for a global option. */
export function formForGlobalOption(schema: SchemaBundle | null, name: string): FormLookup {
	const bespoke = globalForms.get(name);
	if (bespoke) return { spec: build(bespoke, schema), source: 'bespoke' };
	const s = lookup(schema?.globalOptions, name);
	if (s) return { spec: genericForm(s), source: 'schema' };
	return { spec: unknownForm(name), source: 'unknown' };
}

/** The form for a matcher module inside `@name { … }` (request matchers; response matchers are generic). */
export function formForMatcher(schema: SchemaBundle | null, name: string, response = false): FormLookup {
	const bespoke = response ? undefined : matcherForms.get(name);
	if (bespoke) return { spec: build(bespoke, schema), source: 'bespoke' };
	const s: MatcherSchema | undefined = lookup(response ? schema?.responseMatchers : schema?.matchers, name);
	if (s) return { spec: genericMatcherForm(s), source: 'schema' };
	return { spec: unknownForm(name), source: 'unknown' };
}

/** The form for a subdirective the schema describes under its parent (used for nested nodes in the tree). */
export function formForSchemaNode(s: DirectiveSchema): FormLookup {
	return { spec: genericForm(s), source: 'schema' };
}

/** For tests and the coverage page: which directives have bespoke forms. */
export function bespokeDirectiveNames(): string[] {
	return [...directiveForms.keys()].sort();
}

export function bespokeMatcherNames(): string[] {
	return [...matcherForms.keys()].sort();
}
