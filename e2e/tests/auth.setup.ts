import { expect, test as setup } from '@playwright/test';

// Local auth is on in the e2e stack (the shipped default); every other spec reuses this session.
setup('sign in', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel(/user/i).fill('e2e');
	await page.getByLabel(/password/i).fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).not.toHaveURL(/\/login/);
	await page.context().storageState({ path: '.run/auth.json' });
});
