import { X509Certificate } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type CertInfo = { host: string; notAfter: number; issuer: string };

/** The organisation or common name of a certificate issuer, e.g. "Let's Encrypt" or "ZeroSSL". */
function issuerName(issuer: string): string {
	const fields = Object.fromEntries(
		issuer
			.split('\n')
			.map((l) => l.split('='))
			.filter((p) => p.length >= 2)
			.map(([k, ...v]) => [k as string, v.join('=')])
	);
	return fields.O ?? fields.CN ?? issuer.split('\n')[0] ?? '';
}

function* walk(dir: string, depth: number): Generator<string> {
	if (depth < 0) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p, depth - 1);
		else if (e.isFile() && e.name.endsWith('.crt')) yield p;
	}
}

/**
 * Reads every certificate Caddy keeps under `<data>/certificates/<issuer>/<host>/<host>.crt`. Accepts either
 * Caddy's data dir itself or its parent (some setups mount `./data` at `/data` and Caddy writes `/data/caddy`).
 * Unreadable files are skipped. When two files cover one host, the later expiry wins (a renewal).
 */
export function readCerts(dataPath: string): CertInfo[] {
	const roots = [join(dataPath, 'certificates'), join(dataPath, 'caddy', 'certificates')].filter((r) => {
		try {
			return statSync(r).isDirectory();
		} catch {
			return false;
		}
	});
	const byHost = new Map<string, CertInfo>();
	for (const root of roots) {
		for (const file of walk(root, 3)) {
			let cert: X509Certificate;
			try {
				cert = new X509Certificate(readFileSync(file));
			} catch {
				continue;
			}
			const notAfter = Date.parse(cert.validTo);
			if (!Number.isFinite(notAfter)) continue;
			const issuer = issuerName(cert.issuer);
			const hosts = (cert.subjectAltName ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.startsWith('DNS:') || s.startsWith('IP Address:'))
				.map((s) => s.slice(s.indexOf(':') + 1).toLowerCase());
			for (const host of hosts) {
				const prev = byHost.get(host);
				if (!prev || prev.notAfter < notAfter) byHost.set(host, { host, notAfter, issuer });
			}
		}
	}
	return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}
