import { request } from "./client";

export type GoalKind = "general" | "financial" | "habit" | "project";
export type GoalStatus = "active" | "completed" | "expired" | "archived";

export interface Goal {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  kind: GoalKind;
  target_value: number | null;
  current_value: number;
  unit: string | null;
  deadline: string | null;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

export interface GoalsOverview {
  total: number;
  active: number;
  completed: number;
  expired: number;
}

export function listGoals(kind?: GoalKind | null, includeArchived = false): Promise<{ goals: Goal[] }> {
  const query: Record<string, string | number | boolean | null | undefined> = { include_archived: includeArchived };
  if (kind) query.kind = kind;
  return request("/goals", { query });
}

export function getOverview(): Promise<GoalsOverview> {
  return request<GoalsOverview>("/goals/overview");
}

export interface CreateGoalBody {
  title: string;
  description?: string | null;
  kind?: GoalKind;
  target_value?: number | null;
  unit?: string | null;
  deadline?: string | null;
}

export function createGoal(body: CreateGoalBody): Promise<Goal> {
  return request<Goal>("/goals", { method: "POST", body });
}

export interface UpdateGoalBody {
  title?: string;
  description?: string | null;
  kind?: GoalKind;
  target_value?: number | null;
  current_value?: number;
  unit?: string | null;
  deadline?: string | null;
  status?: GoalStatus;
}

export function updateGoal(id: string, body: UpdateGoalBody): Promise<Goal> {
  return request<Goal>(`/goals/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

export function deleteGoal(id: string): Promise<{ ok: boolean }> {
  return request(`/goals/${encodeURIComponent(id)}`, { method: "DELETE" });
}
