export interface User {
  id: string;
  email: string;
  name: string | null;
  /**
   * User-configurable default reminder offsets (minutes before due_time).
   * Applied to new tasks with a due_time when the user doesn't pick
   * explicit offsets. Empty array = no defaults set.
   */
  default_reminder_offsets?: number[];
}

export interface AuthResponse {
  access_token: string;
  user_id: string;
  email: string;
  name: string | null;
}

export type TaskStatus = "pending" | "approved" | "completed" | "rejected";
export type TaskPriority = "low" | "med" | "high";

export interface Task {
  id: string;
  type: string;
  title: string;
  description?: string | null;
  source?: string | null;
  status: TaskStatus;
  payload?: Record<string, unknown> | null;
  due_date?: string | null;
  due_time?: string | null;
  priority?: TaskPriority | null;
  tags?: string[] | null;
  created_at?: string;
  updated_at?: string;
  // Aura sharing (077)
  participants?: string[];
  completed_by_email?: string | null;
  is_owner?: boolean;
  // Multi-offset reminders. Minutes before due_time. Always sorted asc.
  // 0 = at due time. Empty array means no reminders even if due_time set.
  reminder_offsets?: number[];
}

export interface ParticipantsResponse {
  participants: string[];
}

export interface TaskListResponse {
  tasks: Task[];
}

export interface CreateTaskBody {
  type: string;
  title: string;
  description?: string;
  source?: string;
  payload?: Record<string, unknown>;
  due_date?: string | null;
  due_time?: string | null;
  priority?: TaskPriority | null;
  tags?: string[];
  reminder_offsets?: number[];
}

export interface UpdateTaskBody {
  title?: string;
  description?: string;
  status?: TaskStatus;
  // For due_date/due_time/priority: empty string clears the field.
  due_date?: string | null;
  due_time?: string | null;
  priority?: TaskPriority | "" | null;
  tags?: string[];
  reminder_offsets?: number[];
}

export type EntryType = "income" | "expense";
export type EntryStatus = "pending" | "paid" | "received" | "cancelled";

export interface FinancialEntry {
  id: string;
  type: EntryType;
  amount: number;
  currency: string;
  category: string;
  description?: string | null;
  date: string;
  source?: string | null;
  status: EntryStatus;
  created_at?: string;
}

export interface FinanceSummary {
  income: number;
  expenses: number;
  balance: number;
  by_category: Record<string, number>;
}

export interface FinanceBalance {
  total_income: number;
  total_expenses: number;
  adjustment: number;
  balance: number;
}

export interface FinanceEntriesResponse {
  entries: FinancialEntry[];
}
