/**
 * The upstream list of `reverse_proxy`, `forward_auth` and `php_fastcgi`: written inline
 * (`reverse_proxy a b`) or as `to` lines inside the block. The field shows both as one list and writes
 * back in the form the directive already uses (inline unless it only has `to` lines).
 */
import type { Directive } from '@caddy-ui/caddyfile';
import { setArgsFrom, setSub, subs } from '../node';
import type { ListField } from '../types';

export function readUpstreams(node: Directive): string[] {
	return [...node.args.map((a) => a.text), ...subs(node, 'to').flatMap((s) => s.args.map((a) => a.text))];
}

export function writeUpstreams(node: Directive, values: string[]): void {
	const usesTo = subs(node, 'to').length > 0 && node.args.length === 0;
	if (usesTo) {
		setSub(node, 'to', values.length ? values : undefined);
		return;
	}
	setArgsFrom(node, 0, values);
	if (subs(node, 'to').length) setSub(node, 'to', undefined);
}

export function upstreamsField(o: { label?: string; help?: string } = {}): ListField {
	return {
		kind: 'list',
		id: 'upstreams',
		label: o.label ?? 'Upstreams',
		help: o.help ?? 'Backends to send requests to: host:port, https://host, unix//socket, or a placeholder.',
		type: 'upstream',
		placeholder: '10.0.0.10:8080',
		get: readUpstreams,
		set: writeUpstreams
	};
}
