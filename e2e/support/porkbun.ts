// Helpers for the Domains specs: arrange and inspect the fake Porkbun (support/porkbun-fake.mjs).
import { expect, type Page } from '@playwright/test';
import { PORKBUN_URL } from './paths.mjs';

type FakeRecord = {
	id: string;
	host: string;
	type: string;
	content: string;
	ttl: number;
	prio: number | null;
	notes: string | null;
};
type FakeRequest = { method: string; path: string; headers: Record<string, string>; body: unknown };

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${PORKBUN_URL}${path}`, {
		method,
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`fake Porkbun ${method} ${path}: ${res.status} ${text}`);
	return JSON.parse(text) as T;
}

export const fake = {
	/** Back to fixtures/seed.json: example.com, example.net, example.org. */
	reset: () => call('POST', '/__fake/reset'),
	scopes: (scopes: string[]) => call('POST', '/__fake/scopes', { scopes }),
	setDomain: (domain: string, patch: Record<string, unknown>) =>
		call('POST', '/__fake/domain', { domain, patch }),
	setRecords: (
		domain: string,
		records: { name: string; type: string; content: string; ttl?: number; prio?: number; notes?: string }[]
	) => call('POST', '/__fake/records', { domain, records }),
	sslChain: (domain: string, certificatechain: string) =>
		call('POST', '/__fake/ssl', { domain, certificatechain }),
	manyDomains: (count: number) => call('POST', '/__fake/many-domains', { count }),
	recordLimit: (limit: number) => call('POST', '/__fake/record-limit', { limit }),
	respondNext: (canned: { status: number; body?: unknown }, times = 1) =>
		call('POST', '/__fake/respond-next', { canned, times }),
	records: (domain: string) =>
		call<FakeRecord[]>('GET', `/__fake/records?domain=${encodeURIComponent(domain)}`),
	requests: () => call<FakeRequest[]>('GET', '/__fake/requests'),
	/** POSTs that were not dry runs: what would have changed something at Porkbun. */
	writes: async () =>
		(await fake.requests()).filter(
			(r) =>
				r.method === 'POST' &&
				!(typeof r.body === 'object' && r.body !== null && (r.body as { dryRun?: unknown }).dryRun === true)
		)
};

/** Open a tab of a domain and wait for its `<h2>`. */
export async function openDomainTab(page: Page, domain: string, tab: string, heading: string | RegExp) {
	await page.goto(tab === 'overview' ? `/domains/${domain}` : `/domains/${domain}/${tab}`);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(domain);
	await expect(page.getByRole('heading', { level: 2, name: heading }).first()).toBeVisible();
}
