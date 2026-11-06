/**
 * The "effective order" view: Caddy sorts a site's directives by its directive order, not by file
 * order (except inside `route`). This lists the directives of a body in the order Caddy runs them.
 */
import type { Block, Caddyfile, Directive, Node } from '@caddy-ui/caddyfile';
import type { SchemaBundle } from '@caddy-ui/caddy-schema/types';
import { childrenOf } from './document';

export type OrderRow = {
	node: Directive;
	/** Index in the body (file order). */
	fileIndex: number;
	/** Position in Caddy's order, or -1 when the directive is not in it. */
	position: number;
	name: string;
	/** Why the position is what it is, when it needs a word. */
	note?: string;
};

export type OrderView = {
	rows: OrderRow[];
	/** True when the run order differs from the file order. */
	differs: boolean;
	/** Set when the body is a `route`: file order is the run order. */
	literal: boolean;
	/** Directives Caddy cannot place without an `order` global option. */
	unordered: string[];
};

/** `order` lines of the global options block, as the schema's `effectiveOrder` takes them. */
export function customOrder(file: Caddyfile): [string, string, string?][] {
	const global = file.blocks.find((b): b is Extract<Block, { kind: 'global' }> => b.kind === 'global');
	const out: [string, string, string?][] = [];
	for (const n of global?.body ?? []) {
		if (n.kind !== 'directive' || n.name.text !== 'order') continue;
		const [dir, pos, other] = n.args.map((a) => a.text);
		if (dir && pos) out.push([dir, pos, other]);
	}
	return out;
}

function applyCustom(order: string[], custom: readonly (readonly [string, string, string?])[]): string[] {
	const out = [...order];
	for (const [dir, pos, other] of custom) {
		const i = out.indexOf(dir);
		if (i >= 0) out.splice(i, 1);
		if (pos === 'first') out.unshift(dir);
		else if (pos === 'last') out.push(dir);
		else if ((pos === 'before' || pos === 'after') && other) {
			const j = out.indexOf(other);
			if (j < 0) out.push(dir);
			else out.splice(pos === 'before' ? j : j + 1, 0, dir);
		}
	}
	return out;
}

export function effectiveOrderView(
	schema: SchemaBundle | null,
	file: Caddyfile,
	owner: Block | Node
): OrderView {
	const body = childrenOf(owner) ?? [];
	const literal = owner.kind === 'directive' && owner.name.text === 'route';
	const order = applyCustom(schema?.defaultOrder ?? [], customOrder(file));
	const rows: OrderRow[] = [];
	body.forEach((n, fileIndex) => {
		if (n.kind !== 'directive') return;
		const name = n.name.text;
		let position = order.indexOf(name);
		let note: string | undefined;
		if (name === 'import') {
			position = -2;
			note = 'Expanded in place before sorting';
		} else if (position < 0 && (name === 'bind' || name === 'tls' || name === 'log' || name === 'tracing')) {
			position = -2;
			note = 'Not a request handler; configures the site';
		} else if (position < 0) {
			note = 'Not in Caddy’s order; needs an order global option or a route block';
		}
		rows.push({ node: n, fileIndex, position, name, note });
	});
	const handlers = rows.filter((r) => r.position >= 0);
	const sorted = literal
		? rows
		: [...handlers].sort((a, b) => a.position - b.position || a.fileIndex - b.fileIndex);
	const differs = !literal && sorted.some((r, i) => r !== handlers[i]);
	const unordered = rows.filter((r) => r.position === -1).map((r) => r.name);
	return {
		rows: literal ? rows : [...sorted, ...rows.filter((r) => r.position < 0)],
		differs,
		literal,
		unordered: [...new Set(unordered)]
	};
}
