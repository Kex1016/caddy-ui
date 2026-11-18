import { parse, print, type SiteBlock } from '@caddy-ui/caddyfile';
import { addPorkbunChallenge } from '$lib/visual/forms/directives/dns-provider';
import { siteId } from '../../collector/sites';

/**
 * The one Caddyfile edit of the tie-in (docs/porkbun-plan.md §4, wildcard hints): give a site the Porkbun
 * DNS challenge. Pure: text in, text out. The caller sends the result through the config service, so Caddy
 * validates it and the previous file stays in History.
 */
export class SiteEditError extends Error {
	constructor(
		readonly code: 'not_found' | 'unchanged',
		message: string
	) {
		super(message);
		this.name = 'SiteEditError';
	}
}

const addressesOf = (block: SiteBlock): string[] =>
	block.addresses
		.flatMap((t) => t.text.split(','))
		.map((a) => a.trim())
		.filter(Boolean);

/**
 * Add `tls { dns porkbun { … } }` to the site with this id (or the `dns` line to the `tls` block it has).
 * Throws when there is no such site or it already uses the Porkbun challenge.
 */
export function addPorkbunToSite(text: string, id: string): { text: string; addresses: string[] } {
	const { file } = parse(text);
	for (const block of file.blocks) {
		if (block.kind !== 'site') continue;
		const addresses = addressesOf(block);
		if (addresses.length === 0 || siteId(addresses) !== id) continue;
		if (!addPorkbunChallenge(block)) {
			throw new SiteEditError(
				'unchanged',
				`${addresses.join(', ')} already uses the Porkbun DNS challenge. Nothing was changed.`
			);
		}
		return { text: print(file), addresses };
	}
	throw new SiteEditError(
		'not_found',
		'No site with this id. The Caddyfile may have changed; reload the page.'
	);
}
