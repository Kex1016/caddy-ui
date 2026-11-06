import { expect, test } from '@playwright/test';
import { e2eCaddyfile, editorText, openEditor, putOnDisk, readDisk, watchConsole } from '../support/helpers';

// W5b's rule for rows fields (RowsInput): a row reaches the file only once its required columns are filled, and
// clearing a cell to retype it keeps the line (and the comment above it) instead of deleting them.

test('rows stay in the inspector until their required columns are filled', async ({ page, request }) => {
	const clean = watchConsole(page);
	const original = e2eCaddyfile();
	await putOnDisk(request, original);
	await openEditor(page);
	await page.getByRole('button', { name: 'Expand all' }).click();
	await page.getByRole('treeitem', { name: /reverse_proxy.*https:\/\/10\.0\.0\.1:8006/ }).click();

	await expect(page.getByLabel('Header 1')).toHaveValue('Upgrade');
	await expect(page.getByLabel('Header 2')).toHaveValue('Connection');

	// "Add" shows an empty row and writes nothing.
	await page.getByRole('button', { name: 'Add request header' }).click();
	await expect(page.getByLabel('Header 3')).toHaveValue('');
	await expect(page.getByText('matches disk')).toBeVisible();

	// An optional column alone is still not a line.
	await page.getByLabel('Value 3').fill('{remote_host}');
	await expect(page.getByText('matches disk')).toBeVisible();

	// The required column completes it.
	await page.getByLabel('Header 3').fill('X-Real-IP');
	await expect(page.getByText('unapplied edits')).toBeVisible();
	await page.getByRole('button', { name: 'Text', exact: true }).click();
	let text = await editorText(page);
	expect(text).toMatch(
		/header_up Connection \{http\.request\.header\.Connection\}\n\s*header_up X-Real-IP \{remote_host\}\n/
	);
	await page.getByRole('button', { name: 'Visual', exact: true }).click();

	// Clearing a required cell to retype it keeps the line and the comment above it.
	const h1 = page.getByLabel('Header 1');
	await h1.fill('');
	await page.getByRole('button', { name: 'Text', exact: true }).click();
	text = await editorText(page);
	expect(text).toContain('# Critical for noVNC and terminal consoles');
	expect(text).toContain('header_up Upgrade {http.request.header.Upgrade}');
	await page.getByRole('button', { name: 'Visual', exact: true }).click();
	await page.getByLabel('Header 1').fill('X-Upgrade');
	await page.getByRole('button', { name: 'Text', exact: true }).click();
	text = await editorText(page);
	expect(text).toMatch(
		/# Critical for noVNC and terminal consoles\n\s*header_up X-Upgrade \{http\.request\.header\.Upgrade\}/
	);

	// Nothing was written to disk along the way.
	expect(readDisk()).toBe(original);
	clean();
});
