# SDD: Kanban Drag-and-Drop — Real Fix + E2E Validation

## Context

The Tarefas/Kanban view (`frontend/src/tasks/TasksView.tsx`) supports moving cards between 4 columns (Pendentes / Em andamento / Concluídas / Descartadas) via drag-and-drop. A previous fix attempted to deal with a `transform: scale` that aborted HTML5 dragstart in Chromium, but the user reports drag still doesn't work. No automated test currently exercises the drag behavior — only manual inspection.

This spec requires:
1. Diagnose why drag still fails.
2. Apply a robust fix — ideally pointer-event-based drag so behavior is identical across browsers and testable with Playwright's native `dragTo`.
3. Add a Playwright E2E test that literally drags cards and asserts the API call + column membership, so the fix is verified by a real browser.

## Root-cause hypotheses to investigate

Before coding, the engineer should reproduce the bug and verify the actual cause. Likely candidates:

- **H1 — parent `onClick` stops drag**: The card `<div>` has both `draggable=true` and `onClick`. Some browsers suppress dragstart if the drag surface is also a click target and mousedown triggers other handlers. Verify with devtools: does `dragstart` fire on the card at all?
- **H2 — still a transform/filter somewhere**: `.task-card:hover`, `.task-card.dragging`, or an ancestor with `transform` / `will-change` / `filter` can interfere. Audit the entire ancestor chain during drag.
- **H3 — nested button swallows the drag**: If there's a `<button>` or draggable child inside the card that intercepts mousedown before the card sees it.
- **H4 — touch / pointer devices**: HTML5 drag is unreliable on touch; if the user is testing on mobile, the drag never fires. This is a fundamental HTML5-DnD limitation.
- **H5 — React StrictMode double-rendering**: StrictMode in dev runs effects twice; if the `handleDragStart` closure captures stale state, the setter might run against an unmounted tree.

The engineer MUST reproduce by running `npm run dev` + opening the browser + adding `console.log('dragstart')` in the handler. Determine which handler fires (or doesn't).

## Recommended fix: pointer-based drag

HTML5 drag-and-drop has long been a source of flakiness — particularly on touch devices and with React — and is hard to test without browser-level integration. The robust path:

- Replace `draggable` + `dragstart/over/drop` with **pointer events** (`pointerdown` / `pointermove` / `pointerup`) plus element-at-point detection.
- On `pointerdown` on a card: capture `cardKey` + the card's current column, set pointer capture, start tracking. If pointer moves beyond a ~5px threshold, begin drag mode (set `.dragging` class, lock scroll of the column, create a visual "ghost" following the pointer).
- On `pointermove`: compute `document.elementFromPoint(x, y)`, walk ancestors to find the `.tasks-column` under the pointer, highlight it.
- On `pointerup`: if a target column was identified and differs from the origin, fire `moveCard(card, targetColumn)`. Otherwise treat as a click → `toggleExpand`.
- Works identically on desktop and touch. Works with Playwright's standard `locator.dragTo(other)` which simulates pointer events.

This is a ~150-line rewrite of the drag handlers but removes HTML5-DnD flakiness entirely and makes the feature truly testable.

### Must preserve
- `canDrag` rule: confirmed finance entries in "Concluídas" remain non-draggable (`pointerdown` on them is ignored for drag purposes — they can still be clicked to expand).
- Click-to-expand on cards.
- `.task-card--focused` pulse animation for deep-link focus.
- Optimistic UI update + revert on API error.
- All existing API calls: `PATCH /tasks/{id}` for status change; `POST /tasks/{id}/execute` for finance_import; `PATCH /finance/entries/{id}/status` for entry confirm; `DELETE /finance/entries/{id}` for pending-entry reject (and NOT for done→discarded).
- Password modal flow on execute.

### Out of scope
- No react-dnd / dnd-kit / any new npm dep.
- No visual redesign — same card layout, same columns.

## Files

- `frontend/src/tasks/TasksView.tsx` — rewrite the drag handlers (pointer-based)
- `frontend/src/styles.css` — remove any lingering `transform` on `.task-card.dragging`; verify ancestor chain is clean. Add styles for the drag "ghost" if using one. Ensure `touch-action: none` on `.task-card` while drag is active (so mobile doesn't scroll instead of drag).
- `frontend/e2e/kanban-drag.spec.ts` (**new**) — Playwright E2E suite (see below).
- `frontend/playwright.config.ts` — if a `webServer` isn't already configured to boot Vite, add one so the test can run standalone.

## Playwright test spec

The test must **actually drag and verify the outcome**. Approach:

```ts
// frontend/e2e/kanban-drag.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Kanban drag-and-drop', () => {
  test.beforeEach(async ({ page }) => {
    // Stub /tasks with a deterministic pending task.
    await page.route('**/tasks*', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: {
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
          },
        });
      }
      return route.continue();
    });

    // Capture the PATCH call made on drop.
    await page.route('**/tasks/42', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = await route.request().postDataJSON();
        (page as any)._lastPatchBody = body;
        return route.fulfill({ json: { ok: true } });
      }
      return route.continue();
    });

    // Stub finance pending entries (empty).
    await page.route('**/finance/entries*', (route) =>
      route.fulfill({ json: { entries: [] } }),
    );

    await page.goto('/?view=tasks');
    await expect(page.getByText('Task de teste')).toBeVisible();
  });

  test('drags pending task to "Em andamento" and calls PATCH approved', async ({ page }) => {
    const card = page.locator('[data-task-id="42"]');
    const targetColumn = page.locator('.tasks-column', { hasText: 'Em andamento' });

    await card.dragTo(targetColumn);

    // The card should now be inside the "Em andamento" column.
    await expect(targetColumn.locator('[data-task-id="42"]')).toBeVisible();

    // Verify PATCH call was made with status=approved.
    await expect.poll(() => (page as any)._lastPatchBody?.status).toBe('approved');
  });

  test('drags pending task to "Descartadas" and calls PATCH rejected', async ({ page }) => {
    const card = page.locator('[data-task-id="42"]');
    const targetColumn = page.locator('.tasks-column', { hasText: 'Descartadas' });

    await card.dragTo(targetColumn);

    await expect(targetColumn.locator('[data-task-id="42"]')).toBeVisible();
    await expect.poll(() => (page as any)._lastPatchBody?.status).toBe('rejected');
  });

  test('click on card (no drag) toggles expand, does not call PATCH', async ({ page }) => {
    const card = page.locator('[data-task-id="42"]');
    await card.click();
    // Give any debounced handler a moment.
    await page.waitForTimeout(200);
    expect((page as any)._lastPatchBody).toBeUndefined();
    // Expanded detail should be visible (check for any detail-marker element).
    // Match whatever the component renders for the expanded state — if unclear, use
    // the "Descrição" label or similar.
  });
});
```

Notes for the engineer:
- If the current TasksView hits `/tasks/by-date-range` or similar secondary endpoints on mount, stub those too.
- If `/tasks/by-date-range` is called alongside `/tasks`, the intercept above matches both (`**/tasks*`) — confirm by inspecting request URLs.
- Playwright's `dragTo` simulates mousemove over steps and will drive the pointer-based drag correctly. If the test fails because the legacy HTML5 DnD path is still live, the whole migration is incomplete.
- Use `page.waitForTimeout` sparingly — prefer `expect.poll` or `toBeVisible`.

## Acceptance

- Reproduce the bug; document the root cause in the PR description.
- Rewrite drag handlers to pointer events.
- All three Playwright tests above pass locally with `npx playwright test e2e/kanban-drag.spec.ts`.
- Existing tests continue to pass: `cd backend && uv run pytest tests/test_tasks.py tests/test_memory_timeline.py -q` (23 pass), `cd frontend && npx vite build` OK.
- No new npm deps.
- Manually drag on mobile (or use Chromium DevTools device emulation with touch) and confirm drag works.

## Out-of-scope follow-ups (do NOT do in this change)
- Auto-sort cards inside a column.
- Drag reordering within a column.
- Keyboard accessibility for drag — useful but a separate ticket.
