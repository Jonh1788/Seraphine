/**
 * Types for the Tasks module — mirrors the backend contract in
 * packages/mod-tasks/src/mod_tasks (routes.py + models.py).
 */

/** `TASK_STATUSES` in mod_tasks/models.py. */
export type TaskStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';

/** `TASK_TYPES` in mod_tasks/models.py. */
export type TaskType = 'finance_import' | 'calendar_add' | 'whatsapp_reply' | 'generic';

/** `TASK_PRIORITIES` in mod_tasks/models.py. */
export type TaskPriority = 'low' | 'med' | 'high';

/**
 * A row of `GET /tasks` — `dataclasses.asdict(SeraphineTask)`.
 *
 * `status` / `type` stay `string` (not the unions above) because the board
 * renders whatever the server sends, including rows written before a value
 * was added to the enum. `created_at` / `updated_at` are `str | None` on the
 * dataclass but are always set by the service on insert/update, which is the
 * contract the views have always assumed.
 */
export interface Task {
  id: number;
  type: string;
  status: string;
  title: string;
  description: string;
  source: string;
  /** JSON object; older rows may still arrive as a JSON string. */
  payload: Record<string, unknown> | string;
  created_at: string;
  updated_at?: string;
  due_date?: string | null; // YYYY-MM-DD
  due_time?: string | null; // HH:MM 24h
  priority?: string | null; // low / med / high
  tags?: string[];
  category?: string | null; // normalized finance-taxonomy key
  remind?: string | null; // at_time / 1h_before / 1d_before
  user_id?: string | null;
  /** Minutes before due_time, ascending; 0 = at due time. */
  reminder_offsets?: number[];
  completed_by?: string | null;
  completed_by_email?: string | null;
  participants?: string[];
  is_owner?: boolean;
}

/** Envelope of `GET /tasks`. */
export interface TaskListResponse {
  tasks: Task[];
}

/** Query params accepted by `GET /tasks`. */
export interface ListTasksParams {
  limit?: number;
}

/** Body of `POST /tasks` — mirrors the `TaskCreate` pydantic model. */
export interface TaskCreateInput {
  type: string;
  title: string;
  description?: string;
  source?: string;
  payload?: Record<string, unknown>;
  due_date?: string | null;
  due_time?: string | null;
  priority?: string | null;
  tags?: string[] | null;
  category?: string | null;
  remind?: string | null;
  reminder_offsets?: number[] | null;
}

/**
 * Response of `POST /tasks`. The backend answers `{ id, ok }` — it does NOT
 * echo the created task, so callers that need the full row must re-list.
 */
export interface TaskCreateResult {
  id: number;
  ok: boolean;
}
