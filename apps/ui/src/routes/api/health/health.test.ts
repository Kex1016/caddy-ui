import { describe, expect, it } from 'vitest';
import { GET } from './+server';

describe('GET /api/health', () => {
	it('answers ok with the version and uptime, uncached', async () => {
		const res = await GET({} as Parameters<typeof GET>[0]);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = await res.json();
		expect(body).toMatchObject({ status: 'ok', version: expect.any(String) });
		expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
	});
});
