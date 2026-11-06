import { expect, test } from '@playwright/test';
import { applyViaApi, e2eCaddyfile, readDisk, runningConfig, watchConsole } from '../support/helpers';

// PLAN.md §5.1 W3 through the UI: a bad edit is refused with Caddy's error, and History restores an earlier
// revision and reloads the real Caddy.

test('a refused edit changes nothing, and History restores the previous revision', async ({
	page,
	request
}) => {
	const clean = watchConsole(page);
	const good = await applyViaApi(request, e2eCaddyfile());
	const changed = await applyViaApi(request, e2eCaddyfile().replace('10.0.0.102:4567', '10.0.0.102:4568'));
	expect(JSON.stringify(await runningConfig())).toContain('10.0.0.102:4568');

	// Caddy refuses an unknown directive; the file and the running config stay as they were.
	const bad = await request.put('/api/caddyfile', {
		data: {
			text: changed.text.replace('reverse_proxy 10.0.0.102:4568', 'reverse_prox 10.0.0.102:4568'),
			baseHash: changed.hash
		}
	});
	expect(bad.ok()).toBeFalsy();
	expect(await bad.text()).toMatch(/reverse_prox/);
	expect(readDisk()).toBe(changed.text);

	// Restore the revision before the change, from the History page.
	const { revisions } = (await (await request.get('/api/caddyfile/revisions')).json()) as {
		revisions: { id: number }[];
	};
	let target: number | undefined;
	for (const r of revisions) {
		const rev = (await (await request.get(`/api/caddyfile/revisions/${r.id}`)).json()) as { text: string };
		if (rev.text === good.text) {
			target = r.id;
			break;
		}
	}
	expect(target, 'a revision holding the file before the change').toBeDefined();
	await page.goto(`/history?rev=${target}`);
	await page.getByRole('button', { name: 'Restore and reload' }).click();
	await expect(page.getByRole('button', { name: 'This is on disk' })).toBeVisible();
	expect(readDisk()).toBe(good.text);
	expect(JSON.stringify(await runningConfig())).toContain('10.0.0.102:4567');
	clean();
});
