import type { Page } from '@playwright/test';

/** Pre-seed localStorage so onboarding is skipped. Run inside beforeEach. */
export async function seedOnboarded(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('seraphine.onboarded', 'true');
    } catch { /* ignore */ }
  });
}

/** Pre-seed a theme choice before the app mounts. */
export async function seedTheme(page: Page, theme: 'midnight' | 'aurora' | 'sakura'): Promise<void> {
  await page.addInitScript((t: string) => {
    try {
      localStorage.setItem('seraphine.theme', t);
    } catch { /* ignore */ }
  }, theme);
}

/** Clear the onboarding + theme keys so first-run state is reproduced. */
export async function resetClientState(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('seraphine.onboarded');
      localStorage.removeItem('seraphine.theme');
      localStorage.removeItem('seraphine_conversation_id');
      localStorage.removeItem('seraphine.user_name');
      localStorage.removeItem('seraphine.llm_backend');
    } catch { /* ignore */ }
  });
}
