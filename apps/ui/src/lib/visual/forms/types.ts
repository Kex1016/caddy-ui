/**
 * The inspector form API (PLAN.md W5a: "the inspector form API that W5b builds on").
 *
 * A form is a list of fields. Each field knows how to read its value from a directive node and how to
 * write it back; the renderer (`FormRenderer.svelte`) only knows the field kinds. Fields operate on W1's
 * CST nodes directly, so a bespoke form is data plus a handful of accessors, and it is testable without a
 * DOM: build the node from the docs' example, read every field, write the same values back, and the
 * printed text must be unchanged.
 *
 * Most forms are written with the helpers in `fields.ts` (`arg`, `sub`, `flag`, `list`, `rows`, `group`,
 * `variant`), which cover the shapes Caddyfile bodies take. A `custom` field renders a Svelte component
 * for anything beyond that.
 */
import type { ArgType } from '@caddy-ui/caddy-schema/types';
import type { Directive, Node } from '@caddy-ui/caddyfile';
import type { Component } from 'svelte';

/** Context the renderer passes to fields that need to know where the node sits. */
export type FormContext = {
	/** Named matchers defined in the enclosing top-level block (`@name`), for matcher pickers. */
	matcherNames: readonly string[];
	/** Snippet names defined in the file, for `import`. */
	snippetNames: readonly string[];
	/** Placeholders that are valid where the node sits (see `placeholders.ts`). */
	placeholders: readonly { name: string; doc: string; group?: string }[];
	/** True inside a snippet body, where `{args[N]}` is valid. */
	inSnippet: boolean;
	/** True when the node sits in a body that holds HTTP directives (site, handle, route, …). */
	holdsDirectives: boolean;
};

export type Option = { value: string; label: string; doc?: string };

type Base = {
	id: string;
	label: string;
	/** One line under the control. */
	help?: string;
	/** Hide the field unless this holds. */
	when?: (node: Directive, ctx: FormContext) => boolean;
};

/** A single value: positional argument or `name <value>` subdirective. Absent means "not set". */
export type TextField = Base & {
	kind: 'text';
	type: ArgType;
	placeholder?: string;
	required?: boolean;
	/** Keywords accepted besides the type (`off`, `permanent`, …); offered as suggestions. */
	literals?: readonly string[];
	/** A multi-line control (CEL expressions, response bodies). */
	multiline?: boolean;
	/** Offer the placeholder picker. Default true for string, path, url, header and placeholder types. */
	placeholders?: boolean;
	get(node: Directive): string | undefined;
	set(node: Directive, value: string | undefined): void;
};

export type SelectField = Base & {
	kind: 'select';
	options: readonly Option[];
	/** Label of the "not set" choice; omit to make the field required. */
	empty?: string;
	get(node: Directive): string | undefined;
	set(node: Directive, value: string | undefined): void;
};

/** A subdirective that is either present (`tls_insecure_skip_verify`) or not. */
export type ToggleField = Base & {
	kind: 'toggle';
	get(node: Directive): boolean;
	set(node: Directive, on: boolean): void;
};

/** A list of values on one line (`to a b c`, `hide .git .env`) or across the variadic arguments. */
export type ListField = Base & {
	kind: 'list';
	type: ArgType;
	placeholder?: string;
	literals?: readonly string[];
	/** Fixed choices (`precompressed zstd br gzip`); rendered as checkboxes. */
	choices?: readonly Option[];
	get(node: Directive): string[];
	set(node: Directive, values: string[]): void;
};

export type Column = {
	id: string;
	label: string;
	type: ArgType;
	optional?: boolean;
	placeholder?: string;
	options?: readonly Option[];
	/** Prefix operators the value may start with (`+`, `-`, `>`), shown as a hint. */
	prefixes?: readonly string[];
};

/** Repeated lines with the same name (`header_up`, `copy_headers` rows, `map` rows). */
export type RowsField = Base & {
	kind: 'rows';
	columns: readonly Column[];
	/** Columns that depend on the node (`map` has one output column per destination); `columns` otherwise. */
	columnsFor?: (node: Directive) => readonly Column[];
	addLabel?: string;
	get(node: Directive): string[][];
	set(node: Directive, rows: string[][]): void;
};

/** A nested block (`transport http { … }`, `browse { … }`): fields inside operate on the sub node. */
export type GroupField = Base & {
	kind: 'group';
	fields: readonly FieldSpec[];
	/** The sub node, when present. */
	get(node: Directive): Directive | undefined;
	/** Create the sub node (with the variant argument, if any) and return it. */
	create(node: Directive): Directive;
	remove(node: Directive): void;
	/** Start collapsed when present. */
	collapsed?: boolean;
};

/** A module choice whose argument picks the module and whose block holds that module's options. */
export type VariantField = Base & {
	kind: 'variant';
	options: readonly { value: string; label: string; doc?: string; fields: readonly FieldSpec[] }[];
	empty?: string;
	get(node: Directive): { value: string; node: Directive } | undefined;
	/** Switch the module (or remove it with undefined); returns the sub node to edit. */
	set(node: Directive, value: string | undefined): Directive | undefined;
};

export type SectionField = {
	kind: 'section';
	id: string;
	title: string;
	help?: string;
	fields: readonly FieldSpec[];
	collapsed?: boolean;
	when?: (node: Directive, ctx: FormContext) => boolean;
};

export type NoteField = {
	kind: 'note';
	id: string;
	text: string;
	tone?: 'info' | 'warning';
	when?: (node: Directive, ctx: FormContext) => boolean;
};

export type CustomFieldProps = {
	node: Directive;
	ctx: FormContext;
	/** Call after mutating `node`. */
	commit: () => void;
};

export type CustomField = Base & {
	kind: 'custom';
	component: Component<CustomFieldProps>;
};

export type FieldSpec =
	| TextField
	| SelectField
	| ToggleField
	| ListField
	| RowsField
	| GroupField
	| VariantField
	| SectionField
	| NoteField
	| CustomField;

export type FormSpec = {
	/** Directive (or global option, or matcher module) name. */
	name: string;
	title: string;
	summary?: string;
	docsUrl?: string;
	fields: readonly FieldSpec[];
	/** The body holds HTTP directives, shown as children in the tree, not as fields. */
	container?: boolean;
	/**
	 * Body lines the form does not model (so the renderer shows them as a raw "other lines" list) are
	 * found automatically: every directive name a field claims is listed in `claims`.
	 */
	claims?: readonly string[];
	/**
	 * Every directive line of the body is modelled by a rows field (free-form bodies such as `basic_auth`
	 * users or `header` operations), so none of them is an "other line". Only raw lines are left over.
	 */
	claimsAllLines?: boolean | ((node: Directive) => boolean);
	/** A short one-line description for the tree, when the default (arguments joined) is not helpful. */
	describe?: (node: Directive) => string;
};

/** Which body lines of `node` no field of `spec` models. */
export function unclaimedLines(spec: FormSpec, node: Directive): Node[] {
	const claimed = new Set(spec.claims ?? []);
	const all =
		typeof spec.claimsAllLines === 'function' ? spec.claimsAllLines(node) : spec.claimsAllLines === true;
	return (node.body ?? []).filter((n) => !(n.kind === 'directive' && (all || claimed.has(n.name.text))));
}
