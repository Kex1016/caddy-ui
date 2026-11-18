import { X509Certificate } from 'node:crypto';
import type { SslBundle } from '$lib/api/porkbun';
import type { CertInfo, SslInfo } from '$lib/porkbun/forwarding/ssl';
import { config } from './env';

/**
 * The SSL tab's server side (workstream P4). The bundle Porkbun returns holds a private key, so this file only
 * ever hands out what is safe to show: details of the certificates, and whether a key exists.
 */

/** `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD`: whether the private key may be downloaded. Off unless set. */
export const keyDownloadEnabled = (): boolean => config().porkbun.sslKeyDownload;

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const iso = (text: string): string => {
	const t = Date.parse(text);
	return Number.isNaN(t) ? '' : new Date(t).toISOString();
};

function describe(pem: string): CertInfo | null {
	try {
		const c = new X509Certificate(pem);
		return {
			subject: c.subject.replaceAll('\n', ', '),
			issuer: c.issuer.replaceAll('\n', ', '),
			validFrom: iso(c.validFrom),
			validTo: iso(c.validTo),
			serial: c.serialNumber,
			fingerprint256: c.fingerprint256,
			altNames: (c.subjectAltName ?? '')
				.split(',')
				.map((s) => s.trim().replace(/^DNS:/, ''))
				.filter(Boolean),
			isCa: c.ca
		};
	} catch {
		return null;
	}
}

export function inspectBundle(bundle: SslBundle, keyEnabled = keyDownloadEnabled()): SslInfo {
	const blocks = bundle.certificateChain.match(PEM) ?? [];
	const certificates = blocks.map(describe).filter((c): c is CertInfo => c !== null);
	return {
		certificates,
		chainLength: blocks.length,
		unreadable: blocks.length === 0 || certificates.length < blocks.length,
		keyAvailable: bundle.privateKey.trim() !== '',
		keyDownloadEnabled: keyEnabled
	};
}
