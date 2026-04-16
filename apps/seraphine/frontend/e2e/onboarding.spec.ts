import { test, expect } from '@playwright/test';
import { resetClientState } from './_helpers';

test.describe('Onboarding first-run flow (SDD 016-B)', () => {
  test.beforeEach(async ({ page }) => {
    await resetClientState(page);
  });

  test('first visit shows onboarding overlay', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.onboarding-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Seraphine/i).first()).toBeVisible();
  });

  test('completing flow writes localStorage and exits to chat', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.onboarding-overlay')).toBeVisible({ timeout: 10_000 });

    // Step 1: Welcome → click Começar
    await page.getByRole('button', { name: /Come[çc]ar/i }).first().click();

    // Step 2: Setup → fill name, pick backend, advance
    const nameInput = page.locator('.onboarding-input').first();
    await nameInput.fill('Jonathan');
    // Pick Ollama (default, but click to be explicit)
    await page.locator('.onboarding-backend-card').first().click();
    await page.getByRole('button', { name: /Pr[óo]ximo/i }).click();

    // Step 3: Done → click final CTA
    await page.getByRole('button', { name: /conversar|Come[çc]ar/i }).last().click();

    // Overlay disappears
    await expect(page.locator('.onboarding-overlay')).toBeHidden({ timeout: 5_000 });

    // localStorage contracts
    const onboarded = await page.evaluate(() => localStorage.getItem('seraphine.onboarded'));
    const userName = await page.evaluate(() => localStorage.getItem('seraphine.user_name'));
    const backend = await page.evaluate(() => localStorage.getItem('seraphine.llm_backend'));
    expect(onboarded).toBe('true');
    expect(userName).toBe('Jonathan');
    expect(backend).toBe('ollama');
  });

  test('existing user (with conversation_id) auto-skips onboarding', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('seraphine_conversation_id', 'legacy-conv-123');
    });
    await page.goto('/');
    await page.waitForSelector('.topbar__brand', { timeout: 10_000 });
    await expect(page.locator('.onboarding-overlay')).toHaveCount(0);

    // Auto-migration flag set
    const onboarded = await page.evaluate(() => localStorage.getItem('seraphine.onboarded'));
    expect(onboarded).toBe('true');
  });
});
