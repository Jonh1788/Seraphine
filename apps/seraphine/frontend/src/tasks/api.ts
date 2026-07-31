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

export async function createTask(input: TaskCreateInput): Promise<TaskCreateResult> {
  const res = await request<TaskCreateResult>('/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (typeof res?.id !== 'number') throw new Error('Resposta invalida de POST /tasks');
  return res;
}
