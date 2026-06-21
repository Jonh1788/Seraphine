/**
 * Types for the Habits module — mirrors the backend contract in
 * apps/seraphine/backend/.../habits.
 */

export type HabitFrequency = 'daily' | 'weekdays' | 'custom';

export interface Habit {
  id: string;
  title: string;
  icon: string;                    // icon key, see HabitIconMap
  color: string;                   // hex
  frequency: HabitFrequency;
  target_days: number[] | null;    // 0=Mon..6=Sun (only used when frequency === 'custom')
  description: string | null;
  active: boolean;
  created_at: string;
}

export interface HabitWithStatus extends Habit {
  today_completed: boolean;
  current_streak: number;
  best_streak: number;        // true record streak (computed by backend)
  total_completed: number;    // lifetime completed-day count
  is_target_today: boolean;   // whether the habit is due today
}

export interface HabitStreaks {
  current: number;
  best: number;
  total: number;
}

export interface HabitLog {
  id: number;
  habit_id: string;
  date: string;        // YYYY-MM-DD
  completed: boolean;
}

export interface HabitTodayResponse {
  total: number;
  completed: number;
  habits: HabitWithStatus[];
}

export interface HabitListResponse {
  habits: HabitWithStatus[];
}

export interface HabitToggleResponse {
  log: HabitLog;
  current_streak: number;
  best_streak: number;
  total_completed: number;
}

export interface HabitCalendarResponse {
  logs: HabitLog[];
}

/** Batch calendar: logs grouped by habit_id, for the weekly grid (one fetch). */
export interface HabitCalendarBatchResponse {
  logs: Record<string, HabitLog[]>;
}

export interface HabitCreateInput {
  title: string;
  icon?: string;
  color?: string;
  frequency?: HabitFrequency;
  target_days?: number[] | null;
  description?: string | null;
}

export type HabitUpdateInput = Partial<HabitCreateInput> & { active?: boolean };
