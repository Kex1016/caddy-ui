import { afterEach, describe, expect, it } from 'vitest';
import type { Cached, DnssecRecord, GlueHost, RestorePoint } from '$lib/api/porkbun';
import type { Part } from '$lib/porkbun/registry/types';
import { listDomains, porkbun } from '$lib/server/porkbun';
import { resetPorkbunForTests, useFakePorkbun } from '$lib/server/porkbun/testing';
import { load as historyLoad } from '../history/+page.server';
import { load as registryLoad } from './+page.server';

afterEach(() => resetPorkbunForTests());

const event = (domain: string) => ({ params: { domain } }) as never;

type RegistryData = { ns: Part<string[]>; glue: Part<GlueHost[]>; dnssec: Part<DnssecRecord[]> };
type HistoryData = { history: Cached<RestorePoint[]> | null; historyError: unknown };
const registry = async (d: string) => (await registryLoad(event(d))) as RegistryData;
const history = async (d: string) => (await historyLoad(event(d))) as HistoryData;

describe('History and Registry page loads', () => {
	it('make no call with the keys unset', async () => {
		const { fake } = useFakePorkbun({ settings: { apiKey: undefined, apiSecret: undefined } });
		expect(await history('example.com')).toEqual({ history: null, historyError: null });
		expect(await registry('example.com')).toMatchObject({ ns: { value: null, error: null } });
		expect(fake.requests).toHaveLength(0);
	});

	it('leave a domain outside the account to the layout', async () => {
		useFakePorkbun();
		expect(await history('not-mine.test')).toEqual({ history: null, historyError: null });
		expect(await registry('not-mine.test')).toMatchObject({ glue: { value: null, error: null } });
	});

	it('read the three registry settings, cached', async () => {
		const { fake } = useFakePorkbun();
		const data = await registry('example.net');
		expect(data.ns.value?.data).toEqual(['ns1.example-dns.net', 'ns2.example-dns.net']);
		expect(data.dnssec.value?.data).toHaveLength(1);
		expect(data.glue.value?.data).toEqual([]);
		const n = fake.requests.length;
		await registry('example.net');
		expect(fake.requests.length).toBe(n);
	});

	it('show a failing section on its own', async () => {
		const { fake } = useFakePorkbun();
		await listDomains();
		fake.respondNext({
			status: 400,
			body: { status: 'ERROR', code: 'API_ACCESS_DISABLED', message: 'API access is off.' }
		});
		const data = await registry('example.com');
		const errors = [data.ns, data.glue, data.dnssec].filter((p) => p.error);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.error?.code).toBe('API_ACCESS_DISABLED');
	});

	it('list restore points on the History tab', async () => {
		useFakePorkbun();
		await porkbun().dns.create('example.com', { host: 'h', type: 'A', content: '192.0.2.7' });
		const data = await history('example.com');
		expect(data.history?.data).toHaveLength(1);
	});
});
