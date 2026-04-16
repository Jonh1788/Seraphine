import { test, expect } from '@playwright/test';
import { seedOnboarded, seedTheme } from './_helpers';

test.describe('Theme system (SDD 016-A)', () => {
  test.beforeEach(async ({ page }) => {
    await seedOnboarded(page);
  });

  test('default theme applies without flash', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.topbar__brand', { timeout: 10_000 });
    // No data-theme attribute means default midnight is implicit.
    const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
    expect(theme === null || theme === 'midnight').toBeTruthy();
  });

  test('persisted theme applies before first paint', async ({ page }) => {
    await seedTheme(page, 'aurora');
    await page.goto('/');
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('aurora');
  });

  test('switching theme in settings persists across reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.topbar__brand', { timeout: 10_000 });

    // Open settings via the gear button in the topbar.
    await page.getByRole('button', { name: /Configura[çc][oõ]es|Settings/i }).click();
    await expect(page.locator('.settings-drawer--open')).toBeVisible();

    // Click Sakura theme card.
    await page.locator('.theme-card').filter({ hasText: /Sakura/i }).click();

    // dataset updates immediately.
    let theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('sakura');

    // Reload — should still be Sakura (no flash: applied in inline init).
    await page.reload();
    await page.waitForSelector('.topbar__brand', { timeout: 10_000 });
    theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('sakura');

    const stored = await page.evaluate(() => localStorage.getItem('seraphine.theme'));
    expect(stored).toBe('sakura');
  });
});
