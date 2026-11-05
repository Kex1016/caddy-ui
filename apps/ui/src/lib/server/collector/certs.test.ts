import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCerts } from './certs';

describe('readCerts', () => {
	it('reads every SAN from certificates in Caddy’s storage layout', () => {
		const data = mkdtempSync(join(tmpdir(), 'caddy-ui-certs-'));
		const dir = join(
			data,
			'caddy',
			'certificates',
			'acme-v02.api.letsencrypt.org-directory',
			'app.example.com'
		);
		mkdirSync(dir, { recursive: true });
		copyFileSync(join(import.meta.dirname, 'fixtures', 'test-cert.crt'), join(dir, 'app.example.com.crt'));
		writeFileSync(join(dir, 'broken.crt'), 'not a certificate');
		const certs = readCerts(data);
		expect(certs.map((c) => c.host)).toEqual(['*.example.org', 'app.example.com']);
		expect(certs[0]?.issuer).toBe('Caddy UI Test CA');
		expect(certs[0]?.notAfter).toBe(Date.parse('Nov  2 22:59:43 2036 GMT'));
	});

	it('returns nothing when the data directory is missing', () => {
		expect(readCerts('/nonexistent/caddy-ui-test')).toEqual([]);
	});
});
