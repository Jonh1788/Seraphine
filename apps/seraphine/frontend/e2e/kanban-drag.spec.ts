import { test, expect } from '@playwright/test';

// Verifies the pointer-based Kanban drag in TasksView.tsx. Playwright's
// locator.dragTo simulates pointermove steps, which drives our handlers
// (pointerdown → pointermove → pointerup). Network is stubbed so the view
// renders a single deterministic pending task (id=42).

test.describe('Kanban drag-and-drop', () => {
  test.beforeEach(async ({ page }) => {
    // Capture outgoing PATCHes for assertions. Also neuter the Service
    // Worker so it can't intercept / cache our stubbed /tasks responses —
    // the PWA SW serves `/tasks` via stale-while-revalidate in production
    // and its presence made Playwright's route stubs racy.
    await page.addInitScript(() => {
      (window as unknown as { __lastPatchBody?: unknown }).__lastPatchBody = undefined;
      // Hide serviceWorker so the app's registration code is a no-op.
      try {
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          get: () => undefined,
        });
      } catch { /* ignore */ }
    });

    const taskPayload = {
      tasks: [
        {
          id: 42,
          type: 'generic',
          status: 'pending',
          title: 'Task de teste',
          description: 'desc',
          source: 'chat',
          payload: {},
          due_date: null,
          created_at: '2026-04-13T00:00:00Z',
          updated_at: '2026-04-13T00:00:00Z',
        },
      ],
    };

    // Single unified handler for any /tasks* URL. Registered as a RegExp
    // so Playwright matches against the full URL. We anchor with the port
    // so it doesn't match Vite module paths like /src/tasks/index.ts.
    await page.route(/localhost:\d+\/tasks(\/|\?|$)/, async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();

      // PATCH /tasks/:id → capture body + fulfill ok.
      if (method === 'PATCH' && /\/tasks\/\d+(\?|$)/.test(url)) {
        let body: unknown = null;
        try { body = req.postDataJSON(); } catch { /* ignore */ }
        await page.evaluate((b) => {
          (window as unknown as { __lastPatchBody?: unknown }).__lastPatchBody = b;
        }, body);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      }
      // GET /tasks?... list → return the stub.
      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(taskPayload),
        });
      }
      return route.continue();
    });

    // Stub /finance/entries (both pending_review and confirmed → empty).
    await page.route(/localhost:\d+\/finance\/entries/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [] }),
      }),
    );

    await page.goto('/?view=tasks');
    await expect(page.getByText('Task de teste')).toBeVisible();
  });

  // Manually drive pointer events with the mouse API. locator.dragTo only
  // fires two move steps; our pointer handler needs a clear pointerdown →
  // several pointermoves → pointerup sequence to pass the 5px threshold
  // and hit-test the target column.
  const performDrag = async (
    page: import('@playwright/test').Page,
    cardSelector: string,
    columnSelector: string,
  ): Promise<void> => {
    const card = page.locator(cardSelector);
    const column = page.locator(columnSelector);
    const cardBox = await card.boundingBox();
    const colBox = await column.boundingBox();
    if (!cardBox || !colBox) throw new Error('boundingBox() returned null');
    const from = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 };
    const to = { x: colBox.x + colBox.width / 2, y: colBox.y + colBox.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Several steps so the pointermove handler runs repeatedly and crosses
    // the 5px threshold + settles on the destination column.
    await page.mouse.move(from.x + 10, from.y, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 15 });
    await page.mouse.up();
  };

  test('drags pending task to "Em andamento" and calls PATCH approved', async ({ page }) => {
    await performDrag(
      page,
      '[data-task-id="42"]',
      '.tasks-column:has-text("Em andamento")',
    );

    const targetColumn = page.locator('.tasks-column:has-text("Em andamento")');
    await expect(targetColumn.locator('[data-task-id="42"]')).toBeVisible();

    await expect
      .poll(async () => {
        return await page.evaluate(
          () => (window as unknown as { __lastPatchBody?: { status?: string } }).__lastPatchBody?.status,
        );
      })
      .toBe('approved');
  });

  test('drags pending task to "Descartadas" and calls PATCH rejected', async ({ page }) => {
    await performDrag(
      page,
      '[data-task-id="42"]',
      '.tasks-column:has-text("Descartadas")',
    );

    const targetColumn = page.locator('.tasks-column:has-text("Descartadas")');
    await expect(targetColumn.locator('[data-task-id="42"]')).toBeVisible();

    await expect
      .poll(async () => {
        return await page.evaluate(
          () => (window as unknown as { __lastPatchBody?: { status?: string } }).__lastPatchBody?.status,
        );
      })
      .toBe('rejected');
  });

  test('click on card (no drag) toggles expand and does not call PATCH', async ({ page }) => {
    const card = page.locator('[data-task-id="42"]');

    // A click is a pointerdown + pointerup at the same position — below the
    // 5px drag threshold, so our handler falls through to toggleExpand.
    await card.click();

    // Expanded detail should become visible — look for the meta row rendered
    // by the expanded block ("source . type . status").
    await expect(card.locator('.task-card__detail')).toBeVisible();

    // A plain click must not have triggered any PATCH.
    const body = await page.evaluate(
      () => (window as unknown as { __lastPatchBody?: unknown }).__lastPatchBody,
    );
    expect(body).toBeUndefined();
  });
});
