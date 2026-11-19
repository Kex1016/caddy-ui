import { authorOf } from '$lib/server/config/http';
import { audit, porkbun, requireDomain, toResponse } from '$lib/server/porkbun';
import { refuse as refuseWith } from '$lib/server/porkbun-http';
import { keyDownloadEnabled } from '$lib/server/porkbun-ssl';
import type { RequestHandler } from './$types';

/**
 * `?part=chain` is the certificate chain as a PEM file. `?part=key` is the private key, served only when
 * `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` is on; every key download is written to the activity log (without the
 * key). Nothing here is cached by this UI or by the browser.
 */
export const GET: RequestHandler = async ({ params, url, request, locals }) => {
	const part = url.searchParams.get('part');
	if (part !== 'chain' && part !== 'key') return refuseWith('"part" must be chain or key.');
	try {
		const domain = await requireDomain(params.domain);
		if (part === 'key') {
			if (!keyDownloadEnabled()) {
				return refuseWith(
					'Downloading the private key is switched off. Set CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD=true on the caddy-ui service to allow it.',
					403,
					'KEY_DOWNLOAD_DISABLED'
				);
			}
			// A page on another site must not be able to start this download.
			if (request.headers.get('sec-fetch-site') === 'cross-site') {
				return refuseWith('The private key can only be downloaded from this UI.', 403, 'CROSS_SITE');
			}
		}
		const bundle = await porkbun().ssl.retrieve(domain.domain);
		const text = part === 'chain' ? bundle.certificateChain : bundle.privateKey;
		if (text.trim() === '')
			return refuseWith(
				`Porkbun returned no ${part === 'key' ? 'private key' : 'certificate'}.`,
				404,
				'NOT_AVAILABLE'
			);
		if (part === 'key') {
			audit({
				author: authorOf(locals),
				domain: domain.domain,
				action: 'ssl.key-download',
				request: { part },
				ok: true,
				result: {}
			});
		}
		return new Response(text, {
			headers: {
				'content-type': 'application/x-pem-file; charset=utf-8',
				'content-disposition': `attachment; filename="${domain.domain}-${part === 'key' ? 'privkey' : 'fullchain'}.pem"`,
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (err) {
		return toResponse(err);
	}
};
