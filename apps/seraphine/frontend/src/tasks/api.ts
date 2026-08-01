import { API_BASE } from '../api';
import type {
  ListTasksParams,
  Task,
  TaskCreateInput,
  TaskCreateResult,
  TaskListResponse,
  TaskStatus,
} from './types';

/**
 * Error text for a non-2xx response. FastAPI answers `{ detail: "..." }` on
 * every failure raised by mod-tasks, so prefer it; fall back to the status
 * code when the body is missing, empty or not JSON.
 */
async function errorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: unknown };
    if (typeof data?.detail === 'string' && data.detail) return data.detail;
  } catch {
    /* non-JSON body (proxy HTML, empty) — fall through */
  }
  return `Falha HTTP ${res.status}`;
}

/**
 * Every /tasks endpoint used here answers with a JSON body, so there is no
 * empty-body branch to guard.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as T;
}

export async function listTasks(params?: ListTasksParams): Promise<Task[]> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  const query = qs.toString();
  const data = await request<TaskListResponse>(`/tasks${query ? `?${query}` : ''}`);
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

/**
 * `PATCH /tasks/{id}` answers `{ ok: true }` — it does not echo the task, so
 * callers that need the new row must re-list.
 */
export async function updateTaskStatus(id: number, status: TaskStatus): Promise<void> {
  await request<{ ok: boolean }>(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

/**
 * The body of `PATCH /tasks/{id}` — mirrors `TaskPatch` (mod_tasks/routes.py).
 * Every key is optional and only the keys present are written; an empty string
 * CLEARS `due_date` / `due_time` / `priority` / `remind` / `category`, and an
 * empty list clears `tags`.
 */
export interface TaskPatchInput {
  title?: string;
  description?: string;
  status?: string;
  due_date?: string | null;
  due_time?: string | null;
  priority?: string | null;
  tags?: string[];
  category?: string | null;
  remind?: string | null;
  reminder_offsets?: number[];
}

/**
 * Partial edit of one task. `PATCH /tasks/{id}` → `{ ok: true }`.
 *
 * TAKES THE TASK, NOT THE ID, ON PURPOSE — and the reason is a silent
 * overwrite the caller cannot be expected to know about:
 *
 * `TaskService.update_task` (service.py:846) ends with
 * `elif tags is not None: category = _derive_task_category(tags_json, None)`.
 * A patch that carries `tags` and NOT `category` therefore **rewrites the
 * category from the new tags**. Intentional when nobody ever chose one (the
 * chip follows the labels), but destructive when somebody did: add the tag
 * "reunião" to a task the user filed under *moradia* and the row silently
 * becomes *trabalho* — while the screen that sent the patch keeps showing
 * *moradia*. Divergence with no error, which is the same shape as
 * `update_settings` wiping the sibling notification types.
 *
 * So: when a patch carries `tags`, no `category`, and the task HAS one, the
 * current category rides along and survives. With no category to protect,
 * nothing is added and the backend's derivation stays available — this
 * function preserves a choice, it does not veto the feature.
 *
 * Knowledge in the layer, not in the caller — same rule as
 * `setNotificationType`, which sends the whole map for the same reason.
 *
 * The empty patch is refused here because `PATCH` with `{}` answers 422
 * ("empty patch body"), which reaches the UI as an unexplained save failure.
 */
export async function updateTask(
  task: Pick<Task, 'id' | 'category'>,
  patch: TaskPatchInput,
): Promise<void> {
  const body: TaskPatchInput = { ...patch };
  if (Object.keys(body).length === 0) {
    throw new Error('PATCH /tasks sem nenhum campo — não há o que salvar.');
  }
  // THE PREDICATE IS ABOUT THE WIRE, NOT ABOUT THE OBJECT. `'category' in body`
  // reads like the careful version and is the wrong one: `JSON.stringify` DROPS
  // an explicitly-`undefined` key, so `{tags, category: undefined}` reaches the
  // backend as a tags-only patch and gets the category derived away — while
  // `in` reported "the caller stated it" and skipped the protection. `null`, by
  // contrast, survives serialization and really is an explicit "clear it".
  // So: `undefined` (however it got there) = said nothing; anything else = said.
  //
  // And a non-empty check on the CURRENT value, because `''`/`null` both mean
  // "no category" — sending `''` would order a clear instead of leaving the
  // backend's derivation be.
  if (body.tags !== undefined && body.category === undefined && (task.category ?? '') !== '') {
    body.category = task.category;
  }
  await request<{ ok: boolean }>(`/tasks/${task.id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * `DELETE /tasks/{id}` → `{ ok: true }`, or 404 when the row is already gone
 * (which `errorMessage` surfaces as the backend's own "task not found").
 */
export async function deleteTask(id: number): Promise<void> {
  await request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' });
}

export async function createTask(input: TaskCreateInput): Promise<TaskCreateResult> {
  const res = await request<TaskCreateResult>('/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (typeof res?.id !== 'number') throw new Error('Resposta invalida de POST /tasks');
  return res;
}
