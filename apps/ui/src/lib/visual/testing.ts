/**
 * Test helpers for forms, shared by the W5a and W5b tests. Not imported by the app.
 */
import type { Directive } from '@caddy-ui/caddyfile';
import type { FieldSpec, FormContext, FormSpec } from './forms';

export const testCtx: FormContext = {
	matcherNames: [],
	snippetNames: [],
	placeholders: [],
	inSnippet: false,
	holdsDirectives: true
};

/** Read every visible field and write the same value back; the text must not change. */
export function roundTrip(spec: FormSpec, node: Directive, ctx: FormContext = testCtx): void {
	const visit = (fields: readonly FieldSpec[], target: Directive) => {
		for (const f of fields) {
			if ('when' in f && f.when && !f.when(target, ctx)) continue;
			switch (f.kind) {
				case 'text':
				case 'select':
					f.set(target, f.get(target));
					break;
				case 'toggle':
					f.set(target, f.get(target));
					break;
				case 'list':
					f.set(target, f.get(target));
					break;
				case 'rows':
					f.set(target, f.get(target));
					break;
				case 'group': {
					const sub = f.get(target);
					if (sub) visit(f.fields, sub);
					break;
				}
				case 'variant': {
					const cur = f.get(target);
					if (cur) {
						const sub = f.set(target, cur.value);
						const opt = f.options.find((o) => o.value === cur.value);
						if (sub && opt) visit(opt.fields, sub);
					}
					break;
				}
				case 'section':
					visit(f.fields, target);
					break;
			}
		}
	};
	visit(spec.fields, node);
}

type Kind = FieldSpec['kind'];

/**
 * The first field with `id`, searching sections, groups and variant options depth first. Fields inside
 * a group or a variant edit the sub node, so pass that node to them.
 */
export function findField<K extends Kind>(
	fields: readonly FieldSpec[],
	id: string,
	kind?: K
): Extract<FieldSpec, { kind: K }> {
	const walk = (list: readonly FieldSpec[]): FieldSpec | undefined => {
		for (const f of list) {
			if (f.id === id && (!kind || f.kind === kind)) return f;
			const inner =
				f.kind === 'section' || f.kind === 'group'
					? walk(f.fields)
					: f.kind === 'variant'
						? walk(f.options.flatMap((o) => o.fields))
						: undefined;
			if (inner) return inner;
		}
		return undefined;
	};
	const hit = walk(fields);
	if (!hit) throw new Error(`no field ${id}${kind ? ` (${kind})` : ''}`);
	return hit as Extract<FieldSpec, { kind: K }>;
}
