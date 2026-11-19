/** What the SSL tab shows about the certificate Porkbun issued. Never carries the private key. */
export type CertInfo = {
	subject: string;
	issuer: string;
	/** ISO 8601 UTC. */
	validFrom: string;
	validTo: string;
	serial: string;
	fingerprint256: string;
	altNames: string[];
	isCa: boolean;
};

export type SslInfo = {
	/** The leaf first, then the chain, as far as it could be read. */
	certificates: CertInfo[];
	/** How many certificates the chain file holds. */
	chainLength: number;
	/** Set when the chain could not be read as certificates. The download still works. */
	unreadable: boolean;
	/** Porkbun returned a private key (it is never sent to the browser). */
	keyAvailable: boolean;
	/** `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` is on. */
	keyDownloadEnabled: boolean;
};
