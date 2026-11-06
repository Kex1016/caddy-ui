/**
 * Helpers that build the common field shapes, so a bespoke form reads like the directive's syntax:
 *
 *   arg(0, { label: 'Target', type: 'url' })              redir <to>
 *   sub('health_uri', { label: 'URI', type: 'path' })     health_uri <uri>
 *   flag('tls_insecure_skip_verify', { label: '…' })      tls_insecure_skip_verify
 *   list('to', { label: 'Upstreams', type: 'upstream' })  to a b c
 *   rows('header_up', { columns: [...] })                 header_up F V   (repeated)
 *   group('transport', { variant: 'http', fields })       transport http { … }
 *   variant('lb_policy', { options })                     lb_policy cookie { … }
 */
import type { ArgType } from '@caddy-ui/caddy-schema/types';
import { createDirective, setTokenText, type Directive, type Node } from '@caddy-ui/caddyfile';
import { pruneEmptyBody } from '../document';
import {
	ensureBlock,
	getArg,
	getArgsFrom,
	removeSubs,
	replaceArgs,
	setArg,
	setArgsFrom,
	setRows,
	setSub,
	sub,
	subs
} from './node';
import type {
	Column,
	FieldSpec,
	FormContext,
	GroupField,
	ListField,
	NoteField,
	Option,
	RowsField,
	SectionField,
	SelectField,
	TextField,
	ToggleField,
	VariantField
} from './types';

type Common = {
	id?: string;
	label: string;
	help?: string;
	when?: (node: Directive, ctx: FormContext) => boolean;
};

type TextOpts = Common & {
	type?: ArgType;
	placeholder?: string;
	required?: boolean;
	literals?: readonly string[];
	multiline?: boolean;
	placeholders?: boolean;
};

/** Positional argument `index` (after the matcher). */
export function arg(index: number, o: TextOpts): TextField {
	return {
		kind: 'text',
		id: o.id ?? `arg${index}`,
		label: o.label,
		help: o.help,
		when: o.when,
		type: o.type ?? 'string',
		placeholder: o.placeholder,
		required: o.required,
		literals: o.literals,
		multiline: o.multiline,
		placeholders: o.placeholders,
		get: (n) => getArg(n, index),
		set: (n, v) => setArg(n, index, v === '' ? undefined : v)
	};
}

export function argSelect(
	index: number,
	o: Common & { options: readonly Option[]; empty?: string }
): SelectField {
	return {
		kind: 'select',
		id: o.id ?? `arg${index}`,
		label: o.label,
		help: o.help,
		when: o.when,
		options: o.options,
		empty: o.empty,
		get: (n) => getArg(n, index),
		set: (n, v) => setArg(n, index, v)
	};
}

/** The variadic tail of the arguments, from `from` on. */
export function argList(
	from: number,
	o: Common & {
		type?: ArgType;
		placeholder?: string;
		literals?: readonly string[];
		choices?: readonly Option[];
	}
): ListField {
	return {
		kind: 'list',
		id: o.id ?? `args${from}`,
		label: o.label,
		help: o.help,
		when: o.when,
		type: o.type ?? 'string',
		placeholder: o.placeholder,
		literals: o.literals,
		choices: o.choices,
		get: (n) => getArgsFrom(n, from),
		set: (n, v) => setArgsFrom(n, from, v)
	};
}

/** `name <value>`: a subdirective with one argument. */
export function subText(name: string, o: TextOpts): TextField {
	return {
		kind: 'text',
		id: o.id ?? name,
		label: o.label,
		help: o.help,
		when: o.when,
		type: o.type ?? 'string',
		placeholder: o.placeholder,
		required: o.required,
		literals: o.literals,
		multiline: o.multiline,
		placeholders: o.placeholders,
		get: (n) => sub(n, name)?.args[0]?.text,
		set: (n, v) => setSub(n, name, v === undefined || v === '' ? undefined : [v])
	};
}

export function subSelect(
	name: string,
	o: Common & { options: readonly Option[]; empty?: string }
): SelectField {
	return {
		kind: 'select',
		id: o.id ?? name,
		label: o.label,
		help: o.help,
		when: o.when,
		options: o.options,
		empty: o.empty ?? 'Not set',
		get: (n) => sub(n, name)?.args[0]?.text,
		set: (n, v) => setSub(n, name, v === undefined || v === '' ? undefined : [v])
	};
}

/** `name` alone on a line, or not there. */
export function flag(name: string, o: Common): ToggleField {
	return {
		kind: 'toggle',
		id: o.id ?? name,
		label: o.label,
		help: o.help,
		when: o.when,
		get: (n) => sub(n, name) !== undefined,
		set: (n, on) => setSub(n, name, on ? [] : undefined)
	};
}

/** `name a b c` on one line. */
export function subList(
	name: string,
	o: Common & {
		type?: ArgType;
		placeholder?: string;
		literals?: readonly string[];
		choices?: readonly Option[];
	}
): ListField {
	return {
		kind: 'list',
		id: o.id ?? name,
		label: o.label,
		help: o.help,
		when: o.when,
		type: o.type ?? 'string',
		placeholder: o.placeholder,
		literals: o.literals,
		choices: o.choices,
		get: (n) => subs(n, name).flatMap((s) => s.args.map((a) => a.text)),
		set: (n, v) => setSub(n, name, v.length ? v : undefined)
	};
}

/** Repeated `name c1 c2 …` lines, one row each. */
export function rows(name: string, o: Common & { columns: readonly Column[]; addLabel?: string }): RowsField {
	return {
		kind: 'rows',
		id: o.id ?? name,
		label: o.label,
		help: o.help,
		when: o.when,
		columns: o.columns,
		addLabel: o.addLabel,
		get: (n) => subs(n, name).map((s) => s.args.map((a) => a.text)),
		set: (n, r) => setRows(n, name, r.map(trimRow))
	};
}

/**
 * Every body line as a row, the line's name being the first column (`basic_auth` user rows,
 * `uri query { +foo bar }` rows, `header { Field value }` rows).
 */
export function freeformRows(o: Common & { columns: readonly Column[]; addLabel?: string }): RowsField {
	return {
		kind: 'rows',
		id: o.id ?? 'lines',
		label: o.label,
		help: o.help,
		when: o.when,
		columns: o.columns,
		addLabel: o.addLabel,
		get: (n) =>
			(n.body ?? [])
				.filter((x): x is Directive => x.kind === 'directive')
				.map((x) => [x.name.text, ...x.args.map((a) => a.text)]),
		set: (n, r) => {
			const lines = (n.body ?? []).filter((x): x is Directive => x.kind === 'directive');
			const keep = (n.body ?? []).filter((x) => x.kind !== 'directive');
			const out: Node[] = [];
			r.map(trimRow).forEach((row, i) => {
				const [name = '', ...args] = row;
				if (name === '') return;
				const existing = lines[i];
				if (existing) {
					if (existing.name.text !== name) setTokenText(existing.name, name);
					replaceArgs(existing, args);
					out.push(existing);
				} else out.push(createDirective(name, args));
			});
			n.body = [...out, ...keep];
			pruneEmptyBody(n);
		}
	};
}

/** Drop empty trailing optional cells so `header_up X-Foo` prints without an empty value. */
function trimRow(row: readonly string[]): string[] {
	const out = [...row];
	while (out.length && out[out.length - 1] === '') out.pop();
	return out;
}

/** `name [variant] { fields… }`. */
export function group(
	name: string,
	o: Common & { fields: readonly FieldSpec[]; variant?: string; collapsed?: boolean }
): GroupField {
	return {
		kind: 'group',
		id: o.id ?? name,
		label: o.label,
		help: o.help,
		when: o.when,
		fields: o.fields,
		collapsed: o.collapsed,
		get: (n) => {
			const s = sub(n, name);
			return s && (o.variant === undefined || s.args[0]?.text === o.variant) ? s : undefined;
		},
		create: (n) => ensureBlock(n, name, o.variant),
		remove: (n) => removeSubs(n, name)
	};
}

/** `name <module> { module's fields… }`: one block whose first argument picks the option set. */
export function variant(
	name: string,
	o: Common & {
		options: readonly { value: string; label: string; doc?: string; fields: readonly FieldSpec[] }[];
		empty?: string;
	}
): VariantField {
	return {
		kind: 'variant',
		id: o.id ?? name,
		label: o.label,
		help: o.help,
		when: o.when,
		options: o.options,
		empty: o.empty,
		get: (n) => {
			const s = sub(n, name);
			const value = s?.args[0]?.text;
			return s && value !== undefined ? { value, node: s } : undefined;
		},
		set: (n, v) => {
			if (v === undefined) {
				removeSubs(n, name);
				return undefined;
			}
			const s = sub(n, name);
			if (s) {
				if (s.args[0]?.text !== v) {
					// a different module: its options no longer apply
					setArgsFrom(s, 0, [v]);
					delete s.body;
				}
				return s;
			}
			return ensureBlock(n, name, v);
		}
	};
}

export function section(
	title: string,
	fields: readonly FieldSpec[],
	o: { id?: string; help?: string; collapsed?: boolean; when?: SectionField['when'] } = {}
): SectionField {
	return {
		kind: 'section',
		id: o.id ?? 'section:' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
		title,
		help: o.help,
		fields,
		collapsed: o.collapsed,
		when: o.when
	};
}

export function note(
	text: string,
	o: { id?: string; tone?: 'info' | 'warning'; when?: NoteField['when'] } = {}
): NoteField {
	return { kind: 'note', id: o.id ?? 'note-' + text.length, text, tone: o.tone, when: o.when };
}

/** Every subdirective name a list of fields reads or writes, for `FormSpec.claims`. */
export function claimsOf(fields: readonly FieldSpec[]): string[] {
	const out = new Set<string>();
	const visit = (list: readonly FieldSpec[]) => {
		for (const f of list) {
			if (f.kind === 'section') visit(f.fields);
			else if (f.kind === 'group') out.add(f.id);
			else if (f.kind === 'variant') out.add(f.id);
			else if (f.kind !== 'note' && f.kind !== 'custom' && !/^args?\d+$/.test(f.id)) out.add(f.id);
		}
	};
	visit(fields);
	return [...out];
}

export const STATUS_OPTIONS: Option[] = [
	{ value: '301', label: '301 Moved permanently' },
	{ value: '302', label: '302 Found (temporary)' },
	{ value: '303', label: '303 See other' },
	{ value: '307', label: '307 Temporary redirect' },
	{ value: '308', label: '308 Permanent redirect' }
];
