import { format } from '@caddy-ui/caddyfile';
import { expect, test } from '@playwright/test';
import {
	adapt,
	e2eCaddyfile,
	getDoc,
	openEditor,
	putOnDisk,
	readDisk,
	runningConfig,
	watchConsole
} from '../support/helpers';

// PLAN.md §5.1 W5a, in a real browser against a real Caddy: David's (anonymised) Caddyfile opened in the visual
// editor, every block expanded and every row opened, saved with no changes, writes the caddy fmt form of the same
// file with every comment kept, and saving again changes nothing.

const original = e2eCaddyfile();

function comments(text: string): string[] {
	return text
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.startsWith('#'));
}

test.describe.configure({ mode: 'serial' });

test('opening every block and form changes nothing', async ({ page, request }) => {
	const clean = watchConsole(page);
	await putOnDisk(request, original);
	await openEditor(page);
	await page.getByRole('button', { name: 'Expand all' }).click();

	const rows = page.getByRole('treeitem');
	const count = await rows.count();
	expect(count).toBeGreaterThan(100);
	// Open every row in the inspector: a form that writes on open would show up as unapplied edits.
	for (let i = 0; i < count; i++) {
		await rows.nth(i).click();
	}
	await expect(page.getByText('matches disk')).toBeVisible();
	await expect(page.getByText('unapplied edits')).toHaveCount(0);
	expect(readDisk()).toBe(original);
	clean();
});

test('saving unchanged writes the caddy fmt form, keeps comments, and is stable', async ({
	page,
	request
}) => {
	const clean = watchConsole(page);
	const before = await runningConfig();
	await openEditor(page);

	await page.getByRole('button', { name: 'Format' }).click();
	await expect(page.getByText('unapplied edits')).toBeVisible();
	await page.getByRole('button', { name: 'Review and apply' }).click();
	await expect(page.getByRole('heading', { name: 'Review the change' })).toBeVisible();
	await page.getByRole('button', { name: 'Apply and reload Caddy' }).click();
	// Layout only: written to disk, Caddy not reloaded.
	await expect(
		page.getByRole('status').filter({ hasText: "Saved. Caddy's running config is unchanged." })
	).toBeVisible();
	await expect(page.getByText('matches disk')).toBeVisible();

	const saved = readDisk();
	expect(saved).not.toBe(original);
	expect(saved).toBe(format(original));
	expect(comments(saved)).toEqual(comments(original));
	// Same config in the real Caddy: the save only moved whitespace.
	expect(await adapt(saved)).toEqual(await adapt(original));
	expect(await runningConfig()).toEqual(before);

	// Saving again: Format has nothing to do, so there is nothing to apply.
	await page.reload();
	await openEditor(page);
	await page.getByRole('button', { name: 'Format' }).click();
	await expect(page.getByText('matches disk')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Review and apply' })).toBeDisabled();
	// And the API agrees: applying the file as it is changes nothing.
	const res = await request.put('/api/caddyfile', {
		data: { text: saved, baseHash: (await getDoc(request)).hash }
	});
	expect(res.ok()).toBeTruthy();
	const result = (await res.json()) as { changed: boolean };
	expect(result.changed).toBe(false);
	expect(readDisk()).toBe(saved);
	clean();
});

test('an edit through a form changes exactly that line, in text mode and in Caddy', async ({ page }) => {
	const clean = watchConsole(page);
	const before = readDisk();
	await openEditor(page);
	await page
		.getByRole('treeitem', { name: /reverse_proxy.*10\.0\.0\.101:8888/ })
		.first()
		.click();
	const upstream = page.getByLabel('Upstreams 1');
	await expect(upstream).toHaveValue('10.0.0.101:8888');
	await upstream.fill('10.0.0.101:8889');
	await expect(page.getByText('unapplied edits')).toBeVisible();

	await page.getByRole('button', { name: 'Text', exact: true }).click();
	await expect(page.locator('.cm-content')).toContainText('reverse_proxy 10.0.0.101:8889');

	await page.getByRole('button', { name: 'Review and apply' }).click();
	await page.getByRole('button', { name: 'Apply and reload Caddy' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Applied. Caddy reloaded the new config.' })
	).toBeVisible();

	const after = readDisk();
	const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
	expect(changed).toEqual(['\treverse_proxy 10.0.0.101:8889']);
	expect(JSON.stringify(await runningConfig())).toContain('10.0.0.101:8889');
	clean();
});
