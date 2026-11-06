/**
 * Borrow generic fields from the schema for parts of a bespoke form that need no special treatment
 * (the dozens of `reverse_proxy` tuning knobs), with the option to override the label and help text.
 */
import type { DirectiveSchema, SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { subText } from '../fields';
import { subdirectiveField } from '../generic';
import type { FieldSpec } from '../types';

export function resolveSchema(
	schema: SchemaBundle | null,
	path: readonly string[],
	root: 'directives' | 'globalOptions' = 'directives'
): DirectiveSchema | undefined {
	const [head, ...rest] = path;
	if (!schema || head === undefined) return undefined;
	let cur: DirectiveSchema | undefined = schema[root][head];
	for (const step of rest) {
		if (!cur) return undefined;
		cur = cur.subdirectives?.[step] ?? cur.variants?.[step];
	}
	return cur;
}

/** The schema-generated field for `parent.name`, with label/help overrides; a plain text field without a schema. */
export function schemaField(
	schema: SchemaBundle | null,
	parent: readonly string[],
	name: string,
	o: { label?: string; help?: string; root?: 'directives' | 'globalOptions' } = {}
): FieldSpec {
	const s = resolveSchema(schema, [...parent, name], o.root);
	const field: FieldSpec = s
		? subdirectiveField(name, s)
		: subText(name, { label: o.label ?? name.replace(/_/g, ' '), help: o.help });
	if (o.label && 'label' in field) field.label = o.label;
	if (o.help && 'help' in field) field.help = o.help;
	return field;
}

export function schemaFields(
	schema: SchemaBundle | null,
	parent: readonly string[],
	names: readonly (string | [string, { label?: string; help?: string }])[],
	root: 'directives' | 'globalOptions' = 'directives'
): FieldSpec[] {
	return names.map((n) =>
		typeof n === 'string'
			? schemaField(schema, parent, n, { root })
			: schemaField(schema, parent, n[0], { ...n[1], root })
	);
}

export function docsUrlOf(schema: SchemaBundle | null, name: string): string | undefined {
	return schema?.directives[name]?.docsUrl ?? `https://caddyserver.com/docs/caddyfile/directives/${name}`;
}
