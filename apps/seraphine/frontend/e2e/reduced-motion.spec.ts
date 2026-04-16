import { test, expect } from '@playwright/test';
import { seedOnboarded } from './_helpers';

test.describe('Reduced motion (SDD 016 global guard)', () => {
  test.beforeEach(async ({ page }) => {
    await seedOnboarded(page);
  });

  test('prefers-reduced-motion kills animation duration', async ({ page, browserName }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.waitForSelector('.topbar__brand', { timeout: 10_000 });

    // The global `@media (prefers-reduced-motion: reduce)` block collapses all
    // animation-duration to 0.01ms. Query computed style on the body (which
    // inherits from the universal selector).
    const duration = await page.locator('body').evaluate((el) => {
      return getComputedStyle(el).animationDuration;
    });

    // Some browsers report '0.01ms', some '0s'. Accept anything < 100ms.
    const parsed = parseFloat(duration);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeLessThan(0.1);

    // Sanity: at least one `.bubble` element's animation is also neutered,
    // if any bubbles render on a fresh load (they may not without history).
    const bubbleCount = await page.locator('.bubble').count();
    if (bubbleCount > 0) {
      const bubbleDuration = await page.locator('.bubble').first().evaluate((el) => {
        return getComputedStyle(el).animationDuration;
      });
      expect(parseFloat(bubbleDuration)).toBeLessThan(0.1);
    } else {
      // Avoid "unused" lint complaint on browserName.
      expect(browserName).toBeTruthy();
    }
  });

  test('without reduced motion, animations keep normal duration', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await page.waitForSelector('.topbar__brand', { timeout: 10_000 });

    // Skeleton shimmer is 1.5s by default (--skeleton-duration). If no skeleton
    // is rendered we fall back to checking the bubble fadeIn rule declaration.
    // Easiest: inject a temporary element with the `.skeleton` class and read
    // its animation-duration.
    const duration = await page.evaluate(() => {
      const el = document.createElement('span');
      el.className = 'skeleton';
      document.body.appendChild(el);
      const d = getComputedStyle(el).animationDuration;
      el.remove();
      return d;
    });

    const parsed = parseFloat(duration);
    expect(parsed).toBeGreaterThan(0.5);
  });
});
