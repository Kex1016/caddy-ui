import { describe, expect, it } from 'vitest';
import { recentSlowLoads, SLOW_MS, Timing } from './timing';

describe('Timing', () => {
	it('builds a Server-Timing header with one entry per step and the total', () => {
		const t = new Timing();
		expect(t.instrumented).toBe(false);
		t.measure('states', () => 1);
		t.add('latestProbes', 1.234, 'snapshot');
		t.add('tail', undefined, 'lag 0 B');
		t.add('weird name"', 2);
		expect(t.instrumented).toBe(true);
		expect(t.header()).toMatch(
			/^states;dur=[\d.]+, latestProbes;dur=1\.2;desc="snapshot", tail;desc="lag 0 B", weird_name_;dur=2, total;dur=[\d.]+$/
		);
	});

	it('counts streamed parts, and logs a load over the threshold with its steps', async () => {
		const t = new Timing();
		const lines: string[] = [];
		const part = t.defer('charts', () => {
			const end = performance.now() + SLOW_MS + 20;
			while (performance.now() < end) {
				// a slow part
			}
			return 42;
		});
		// The part has not run yet: it waits for the response to start.
		expect(t.steps).toEqual([]);
		expect(await part).toBe(42);
		await t.report('/?range=30d', (l) => lines.push(l));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^caddy-ui: slow load \/\?range=30d \d+(\.\d)? ms: charts=\d+(\.\d)?\(streamed\)$/
		);
		expect(recentSlowLoads()[0]).toMatchObject({ path: '/?range=30d' });
	});

	it('stays quiet for a fast load, and for requests that recorded nothing', async () => {
		const lines: string[] = [];
		const fast = new Timing();
		fast.measure('states', () => 0);
		await fast.report('/', (l) => lines.push(l));
		await new Timing().report('/favicon.ico', (l) => lines.push(l));
		expect(lines).toEqual([]);
	});
});
