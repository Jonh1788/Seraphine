export interface User {
  id: string;
  email: string;
}

export interface AuthResponse {
  access_token: string;
  user_id: string;
  email: string;
}

export type TaskStatus = "pending" | "approved" | "completed" | "rejected";

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
  created_at?: string;
  updated_at?: string;
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
