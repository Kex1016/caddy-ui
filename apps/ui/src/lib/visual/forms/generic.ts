/**
 * A form built from the schema alone: the fallback for every directive, global option and subdirective
 * that has no bespoke form (plugin directives get only the raw row). W5b replaces these one category at
 * a time; the field helpers mean a bespoke form is usually the generic one with better labels and order.
 */
import type { ArgSchema, DirectiveSchema, MatcherSchema } from '@caddy-ui/caddy-schema/types';
import {
	arg,
	argList,
	argSelect,
	claimsOf,
	flag,
	freeformRows,
	group,
	note,
	rows,
	subList,
	subSelect,
	subText,
	variant
} from './fields';
import type { Column, FieldSpec, FormSpec, Option } from './types';

const humanize = (name: string) => name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function optionsOf(a: ArgSchema): Option[] | undefined {
	const values = a.type === 'enum' ? a.enum : undefined;
	const literals = a.literals;
	if (!values && !literals) return undefined;
	return [...(values ?? []), ...(literals ?? [])].map((v) => ({ value: v, label: v }));
}

function firstLine(doc: string): string {
	const s = doc.replace(/\s+/g, ' ').trim();
	const end = s.search(/\.\s/);
	return end > 0 ? s.slice(0, end + 1) : s;
}

/** Positional-argument fields for an args list (the directive's own, or a subdirective's). */
export function argFields(args: readonly ArgSchema[]): FieldSpec[] {
	const out: FieldSpec[] = [];
	args.forEach((a, i) => {
		const label = humanize(a.name);
		const help = firstLine(a.doc) || undefined;
		if (a.variadic) {
			out.push(
				argList(i, { label, help, type: a.type === 'enum' ? 'string' : a.type, literals: a.literals })
			);
			return;
		}
		const options = a.type === 'enum' ? optionsOf(a) : undefined;
		if (options?.length) {
			out.push(argSelect(i, { label, help, options, empty: a.optional ? 'Not set' : undefined }));
			return;
		}
		out.push(arg(i, { label, help, type: a.type, required: !a.optional, literals: a.literals }));
	});
	return out;
}

/** The column list for a repeated subdirective row (`header_up field value [replacement]`). */
export function columnsOf(args: readonly ArgSchema[]): Column[] {
	return args.map((a) => ({
		id: a.name,
		label: humanize(a.name),
		type: a.type === 'enum' ? 'string' : a.type,
		optional: a.optional,
		options: a.type === 'enum' ? optionsOf(a) : undefined,
		prefixes: a.prefixes
	}));
}

/**
 * Fields for one subdirective entry of a schema. The shape of the schema decides the control:
 * no args → toggle; a block with options → group; module variants → variant; one arg → text/select;
 * one variadic arg → list; several args → rows.
 */
export function subdirectiveField(name: string, s: DirectiveSchema): FieldSpec {
	const label = humanize(name);
	const help = firstLine(s.summary) || undefined;
	if (s.variants && Object.keys(s.variants).length) {
		return variant(name, {
			label,
			help,
			empty: 'Not set',
			options: Object.entries(s.variants).map(([value, v]) => ({
				value,
				label: value,
				doc: firstLine(v.summary) || undefined,
				fields: bodyFields(v)
			}))
		});
	}
	if (s.subdirectives && Object.keys(s.subdirectives).length) {
		return group(name, { label, help, fields: [...argFields(s.args), ...bodyFields(s)], collapsed: true });
	}
	if (s.freeformBody && s.rows?.length) {
		return group(name, { label, help, fields: [rowsFieldFor(name, s.rows[0]!)], collapsed: true });
	}
	if (s.args.length === 0) return flag(name, { label, help });
	const [a] = s.args;
	if (s.args.length === 1 && a) {
		if (a.variadic) {
			const choices = a.type === 'enum' && a.enum ? a.enum.map((v) => ({ value: v, label: v })) : undefined;
			return subList(name, {
				label,
				help,
				type: a.type === 'enum' ? 'string' : a.type,
				literals: a.literals,
				choices
			});
		}
		const options = optionsOf(a);
		if (a.type === 'enum' && options?.length) return subSelect(name, { label, help, options });
		return subText(name, { label, help, type: a.type, literals: a.literals });
	}
	return rows(name, { label, help, columns: columnsOf(s.args) });
}

/** A rows field for free-form body rows (`basic_auth` users, `map` entries): every body line is a row. */
function rowsFieldFor(name: string, cols: readonly ArgSchema[]) {
	return freeformRows({ id: `${name}-rows`, label: 'Lines', columns: columnsOf(cols) });
}

export function bodyFields(s: DirectiveSchema): FieldSpec[] {
	const out: FieldSpec[] = [];
	for (const [name, sub] of Object.entries(s.subdirectives ?? {})) out.push(subdirectiveField(name, sub));
	if (s.freeformBody && !s.rows?.length)
		out.push(note('This block takes free-form lines; edit them as text below.'));
	return out;
}

/** The generic form for a directive or global option. */
export function genericForm(s: DirectiveSchema): FormSpec {
	const fields = [...argFields(s.args), ...bodyFields(s)];
	return {
		name: s.name,
		title: s.name,
		summary: s.summary,
		docsUrl: s.docsUrl,
		fields,
		container: s.allowsDirectives === true,
		claims: claimsOf(fields)
	};
}

/** The generic form for a matcher module (`host a b`, `header Field value`). */
export function genericMatcherForm(m: MatcherSchema): FormSpec {
	const fields: FieldSpec[] = argFields(m.args);
	if (m.subdirectives)
		for (const [name, sub] of Object.entries(m.subdirectives)) fields.push(subdirectiveField(name, sub));
	return {
		name: m.name,
		title: m.name,
		summary: m.summary,
		docsUrl: m.docsUrl,
		fields,
		claims: claimsOf(fields)
	};
}

/** A form for a directive the schema does not know: arguments as a list, body as raw text. */
export function unknownForm(name: string): FormSpec {
	return {
		name,
		title: name,
		summary: 'Not in the schema (a plugin directive or a typo). Edit it as text below.',
		fields: [argList(0, { label: 'Arguments', type: 'string' })],
		claims: []
	};
}
