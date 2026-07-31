import type { SeraphineTask } from '../finance/types';

/**
 * Task as the calendar consumes it. The backend serves the same row from
 * `/tasks/by-date-range` that the finance/tasks views already use, so the
 * shape is shared instead of duplicated.
 */
export type Task = SeraphineTask;

/* -- /calendar/aggregate payload (SDD 083) --------------------------- */

export interface AggTaskSummary {
  id: number;
  title: string;
  status: string;
}

export interface AggHabitLog {
  habit_id: string;
  name: string;
  completed: boolean;
}

export interface AggHealth {
  steps: number;
  sleep_minutes: number | null;
  sleep_hours: number | null;
  calories: number;
  resting_hr: number | null;
}

export interface AggWater {
  intake_ml: number;
  goal_ml: number;
}

export interface AggMood {
  avg_valence: number;
  predominant_label: string;
}

export interface AggFocus {
  total_min: number;
  sessions_count: number;
}

export interface AggJournal {
  count: number;
}

export interface AggEvent {
  title: string;
  start: string;
  end: string;
}

/**
 * One day of `GET /calendar/aggregate`. Every dimension the backend can
 * fill is listed; the ones with no data for that day come back `null`
 * (objects) or empty (lists). `score` is computed server-side (0-7).
 */
export interface AggregateDay {
  date: string;              // YYYY-MM-DD
  tasks: AggTaskSummary[];
  habits: AggHabitLog[];
  health: AggHealth | null;
  water: AggWater | null;
  mood: AggMood | null;
  focus: AggFocus | null;
  journal: AggJournal | null;
  events: AggEvent[];
  score: number;
}

export interface AggregateResponse {
  days: AggregateDay[];
}

export interface TasksByRangeResponse {
  tasks: Task[];
}
