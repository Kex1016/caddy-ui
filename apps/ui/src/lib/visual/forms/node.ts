/**
 * Small edits on a directive's body, used by the field helpers. They keep comments and the position of
 * existing lines, and remove an empty body so `foo {}` prints as `foo`.
 */
import { createDirective, createToken, type Directive, type Node } from '@caddy-ui/caddyfile';
import { pruneEmptyBody } from '../document';

/**
 * Set the arguments, keeping every existing token whose text is unchanged (so its quoting and spacing
 * survive) and creating tokens only for new values.
 */
export function replaceArgs(node: Directive, args: readonly string[]): void {
	node.args = args.map((text, i) => {
		const old = node.args[i];
		return old && old.text === text ? old : createToken(text);
	});
	delete node.span;
}

export function subs(node: Directive, name: string): Directive[] {
	return (node.body ?? []).filter((n): n is Directive => n.kind === 'directive' && n.name.text === name);
}

export function sub(node: Directive, name: string): Directive | undefined {
	return subs(node, name)[0];
}

export function body(node: Directive): Node[] {
	return (node.body ??= []);
}

/** Append a body line, after the last line with the same name when there is one. */
export function addSub(node: Directive, line: Directive): Directive {
	const list = body(node);
	let at = list.length;
	for (let i = list.length - 1; i >= 0; i--) {
		const n = list[i];
		if (n?.kind === 'directive' && n.name.text === line.name.text) {
			at = i + 1;
			break;
		}
	}
	list.splice(at, 0, line);
	return line;
}

export function removeSubs(node: Directive, name: string): void {
	if (!node.body) return;
	node.body = node.body.filter((n) => !(n.kind === 'directive' && n.name.text === name));
	pruneEmptyBody(node);
}

/** Set `name <args...>` as a single line: created, updated in place, or removed with `undefined`. */
export function setSub(node: Directive, name: string, args: readonly string[] | undefined): void {
	const existing = subs(node, name);
	if (args === undefined) {
		removeSubs(node, name);
		return;
	}
	const [first, ...rest] = existing;
	if (first) {
		replaceArgs(first, args);
		if (rest.length) node.body = (node.body ?? []).filter((n) => !rest.includes(n as Directive));
	} else {
		addSub(node, createDirective(name, args));
	}
}

/**
 * Replace every `name …` line with `rows`: existing lines are updated in place (their comments stay),
 * extra rows are added after the last one, surplus lines are removed from the end.
 */
export function setRows(node: Directive, name: string, rows: readonly (readonly string[])[]): void {
	const existing = subs(node, name);
	const n = Math.min(existing.length, rows.length);
	for (let i = 0; i < n; i++) replaceArgs(existing[i]!, rows[i]!);
	for (let i = n; i < rows.length; i++) addSub(node, createDirective(name, rows[i]!));
	if (existing.length > rows.length) {
		const drop = new Set<Node>(existing.slice(rows.length));
		node.body = (node.body ?? []).filter((x) => !drop.has(x));
		pruneEmptyBody(node);
	}
}

/** Ensure a `name [variant] { … }` block exists and return it. */
export function ensureBlock(node: Directive, name: string, variant?: string): Directive {
	const found = sub(node, name);
	if (found) {
		if (variant !== undefined && found.args[0]?.text !== variant) replaceArgs(found, [variant]);
		found.body ??= [];
		return found;
	}
	return addSub(node, createDirective(name, variant === undefined ? [] : [variant], { body: [] }));
}

/** Positional argument helpers (the matcher is kept apart in `node.matcher`). */
export function getArg(node: Directive, index: number): string | undefined {
	return node.args[index]?.text;
}

export function setArg(node: Directive, index: number, value: string | undefined): void {
	const args = node.args.map((a) => a.text);
	if (value === undefined) {
		if (index < args.length) args.splice(index);
	} else {
		while (args.length < index) args.push('');
		args[index] = value;
	}
	replaceArgs(node, args);
}

export function getArgsFrom(node: Directive, from: number): string[] {
	return node.args.slice(from).map((a) => a.text);
}

export function setArgsFrom(node: Directive, from: number, values: readonly string[]): void {
	replaceArgs(node, [...node.args.slice(0, from).map((a) => a.text), ...values]);
}
