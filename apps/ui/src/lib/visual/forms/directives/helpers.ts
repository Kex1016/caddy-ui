/**
 * Field shapes the W5b forms need beyond `fields.ts`: one argument of a multi-argument subdirective
 * (`read_timeout 10s 1024`, `protocols tls1.2 tls1.3`), body lines as rows with some names left out
 * (`header { … match … }`), rows that map to lines in a custom way, and the optional leading capture
 * name of `header_regexp` / `vars_regexp`.
 *
 * Every helper edits lines in place, so comments and the order of the lines the user did not touch stay
 * where they are.
 */
import type { ArgType } from '@caddy-ui/caddy-schema/types';
import { createDirective, setTokenText, type Directive, type Node } from '@caddy-ui/caddyfile';
import { pruneEmptyBody } from '../../document';
import { addSub, getArg, removeSubs, replaceArgs, setArg, sub } from '../node';
import type { Column, FormContext, ListField, Option, RowsField, SelectField, TextField } from '../types';

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

/**
 * Set argument `index` of the first `name` line. Clearing it drops it and every argument after it; the
 * line goes away once it has no arguments and no block left, unless `keepLine` (a bare `gzip` line
 * still means something).
 */
export function writeSubArg(
	node: Directive,
	name: string,
	index: number,
	value: string | undefined,
	keepLine = false
): void {
	const line = sub(node, name);
	if (value === undefined || value === '') {
		if (!line) return;
		const args = line.args.map((a) => a.text);
		if (index < args.length) args.splice(index);
		if (args.length === 0 && !line.body && !keepLine) removeSubs(node, name);
		else replaceArgs(line, args);
		return;
	}
	if (!line) {
		const args: string[] = [];
		while (args.length < index) args.push('');
		args.push(value);
		addSub(node, createDirective(name, args));
		return;
	}
	setArg(line, index, value);
}

/** Argument `index` of the `name` line as a text field. */
export function subArg(name: string, index: number, o: TextOpts & { keepLine?: boolean }): TextField {
	return {
		kind: 'text',
		id: o.id ?? (index === 0 ? name : `${name}#${index}`),
		label: o.label,
		help: o.help,
		when: o.when,
		type: o.type ?? 'string',
		placeholder: o.placeholder,
		required: o.required,
		literals: o.literals,
		multiline: o.multiline,
		placeholders: o.placeholders,
		get: (n) => sub(n, name)?.args[index]?.text,
		set: (n, v) => writeSubArg(n, name, index, v, o.keepLine)
	};
}

export function subArgSelect(
	name: string,
	index: number,
	o: Common & { options: readonly Option[]; empty?: string; keepLine?: boolean }
): SelectField {
	return {
		kind: 'select',
		id: o.id ?? (index === 0 ? name : `${name}#${index}`),
		label: o.label,
		help: o.help,
		when: o.when,
		options: o.options,
		empty: o.empty ?? 'Not set',
		get: (n) => sub(n, name)?.args[index]?.text,
		set: (n, v) => writeSubArg(n, name, index, v, o.keepLine)
	};
}

/** Arguments from `from` on of the `name` line (`dns cloudflare <params…>`). */
export function subArgList(
	name: string,
	from: number,
	o: Common & { type?: ArgType; placeholder?: string; literals?: readonly string[] }
): ListField {
	return {
		kind: 'list',
		id: o.id ?? `${name}#${from}+`,
		label: o.label,
		help: o.help,
		when: o.when,
		type: o.type ?? 'string',
		placeholder: o.placeholder,
		literals: o.literals,
		get: (n) => (sub(n, name)?.args ?? []).slice(from).map((a) => a.text),
		set: (n, values) => {
			const line = sub(n, name);
			if (!line) {
				if (!values.length) return;
				const head: string[] = [];
				while (head.length < from) head.push('');
				addSub(n, createDirective(name, [...head, ...values]));
				return;
			}
			replaceArgs(line, [...line.args.slice(0, from).map((a) => a.text), ...values]);
		}
	};
}

/** The body's directive lines, minus the names a form models with other fields. */
export function bodyLines(node: Directive, except: readonly string[] = []): Directive[] {
	return (node.body ?? []).filter(
		(x): x is Directive => x.kind === 'directive' && !except.includes(x.name.text)
	);
}

/**
 * Body lines as rows. By default a row is `[name, ...args]`; `toRow`/`fromRow` map other shapes
 * (`push` lines with an optional method). Existing lines are updated in place, new lines go after the
 * last row, surplus lines are removed; lines named in `except` are never touched.
 */
export function lineRows(
	o: Common & {
		columns: readonly Column[];
		columnsFor?: (node: Directive) => readonly Column[];
		addLabel?: string;
		except?: readonly string[];
		toRow?: (line: Directive) => string[];
		fromRow?: (row: readonly string[]) => [name: string, args: string[]] | undefined;
	}
): RowsField {
	const except = o.except ?? [];
	const toRow = o.toRow ?? ((l: Directive) => [l.name.text, ...l.args.map((a) => a.text)]);
	const fromRow =
		o.fromRow ??
		((row: readonly string[]): [string, string[]] | undefined => {
			const [name = '', ...args] = trimEnd(row);
			return name === '' ? undefined : [name, args];
		});
	return {
		kind: 'rows',
		id: o.id ?? 'lines',
		label: o.label,
		help: o.help,
		when: o.when,
		columns: o.columns,
		columnsFor: o.columnsFor,
		addLabel: o.addLabel,
		get: (n) => bodyLines(n, except).map(toRow),
		set: (n, rows) => {
			const lines = bodyLines(n, except);
			const wanted = rows.map(fromRow).filter((r): r is [string, string[]] => r !== undefined);
			const shared = Math.min(lines.length, wanted.length);
			for (let i = 0; i < shared; i++) {
				const line = lines[i]!;
				const [name, args] = wanted[i]!;
				if (line.name.text !== name) setTokenText(line.name, name);
				replaceArgs(line, args);
			}
			if (lines.length > wanted.length) {
				const drop = new Set<Node>(lines.slice(wanted.length));
				n.body = (n.body ?? []).filter((x) => !drop.has(x));
				pruneEmptyBody(n);
			}
			if (wanted.length > lines.length) {
				const list = (n.body ??= []);
				const last = lines.length
					? list.indexOf(lines[lines.length - 1]!) + 1
					: firstAfterExcept(list, except);
				const fresh = wanted.slice(lines.length).map(([name, args]) => createDirective(name, args));
				list.splice(last, 0, ...fresh);
			}
		}
	};
}

/** New rows go before the lines the form models elsewhere (`match`, `default`), so those stay last. */
function firstAfterExcept(list: readonly Node[], except: readonly string[]): number {
	const i = list.findIndex((x) => x.kind === 'directive' && except.includes(x.name.text));
	return i === -1 ? list.length : i;
}

export function trimEnd(row: readonly string[]): string[] {
	const out = [...row];
	while (out.length && out[out.length - 1] === '') out.pop();
	return out;
}

/**
 * `module [<name>] <a> <b>`: an optional capture name in front of a fixed number of arguments
 * (`header_regexp [name] <field> <regexp>`, `vars_regexp [name] <variable> <regexp>`). The name is
 * present when the line has `required + 1` arguments.
 */
export function optionalNameFields(
	required: readonly (TextOpts & { id: string })[],
	nameOpts: Partial<TextOpts> = {}
): TextField[] {
	const count = required.length;
	const hasName = (n: Directive) => n.args.length > count;
	const values = (n: Directive) => (hasName(n) ? n.args.slice(1) : n.args).map((a) => a.text);
	const write = (n: Directive, name: string | undefined, rest: string[]) => {
		const tail = trimEnd(rest);
		replaceArgs(n, name ? [name, ...pad(tail, count)] : tail);
	};
	const nameField: TextField = {
		kind: 'text',
		id: 'name',
		label: nameOpts.label ?? 'Capture name',
		type: 'string',
		placeholder: 'optional',
		help:
			nameOpts.help ??
			'Captures become {re.name.1}, {re.name.2}, …; without a name the matcher’s own name is used.',
		placeholders: false,
		get: (n) => (hasName(n) ? getArg(n, 0) : undefined),
		set: (n, v) => write(n, v || undefined, values(n))
	};
	const fields = required.map((o, i): TextField => ({
		kind: 'text',
		id: o.id,
		label: o.label,
		help: o.help,
		type: o.type ?? 'string',
		placeholder: o.placeholder,
		required: true,
		placeholders: o.placeholders,
		get: (n) => values(n)[i],
		set: (n, v) => {
			const rest = pad(values(n), count);
			rest[i] = v ?? '';
			write(n, hasName(n) ? getArg(n, 0) : undefined, rest);
		}
	}));
	return [...fields, nameField];
}

function pad(values: readonly string[], count: number): string[] {
	const out = [...values];
	while (out.length < count) out.push('');
	return out;
}

export const isStatusCode = (v: string | undefined): boolean => v !== undefined && /^[1-5]\d\d$/.test(v);

export const HTTP_METHODS = [
	'GET',
	'HEAD',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
	'CONNECT',
	'TRACE'
] as const;

export const HEADER_ROW_COLUMNS: readonly Column[] = [
	{
		id: 'field',
		label: 'Header',
		type: 'header',
		prefixes: ['+', '-', '?', '>'],
		placeholder: 'X-Frame-Options'
	},
	{ id: 'value', label: 'Value or find', type: 'string', optional: true, placeholder: 'DENY' },
	{ id: 'replacement', label: 'Replace with', type: 'string', optional: true }
];
