import { request } from "./client";

export interface Habit {
  id: string;
  user_id: string;
  name: string;
  color: string;
  target_per_week: number;
  archived: boolean;
  created_at: string;
  done_today: boolean;
  streak: number;
  week_done_count: number;
}

export interface HabitsRing {
  done: number;
  target: number;
  ratio: number;
}

export interface HabitsToday {
  habits: Habit[];
  ring: HabitsRing;
  heatmap: Record<string, number>;
  heatmap_from: string;
  heatmap_to: string;
}

export function getToday(): Promise<HabitsToday> {
  return request<HabitsToday>("/habits/today");
}

export interface CreateHabitBody {
  name: string;
  color?: string;
  target_per_week?: number;
}

export function createHabit(body: CreateHabitBody): Promise<Habit> {
  return request<Habit>("/habits", { method: "POST", body });
}

export interface UpdateHabitBody {
  name?: string;
  color?: string;
  target_per_week?: number;
  archived?: boolean;
}

export function updateHabit(id: string, body: UpdateHabitBody): Promise<Habit> {
  return request<Habit>(`/habits/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteHabit(id: string): Promise<{ ok: boolean }> {
  return request(`/habits/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function toggleHabit(id: string): Promise<{ done: boolean }> {
  return request<{ done: boolean }>(
    `/habits/${encodeURIComponent(id)}/toggle`,
    { method: "POST" },
  );
}
