/**
 * Types for the Water Tracking module — mirrors the backend contract in
 * apps/seraphine/backend/seraphine/water.
 */

export type WaterActivityLevel = 'sedentary' | 'moderate' | 'active';

export interface WaterProfile {
  weight_kg: number;
  height_cm: number | null;
  activity_level: WaterActivityLevel;
  daily_goal_ml: number;
  reminder_enabled: boolean;
  reminder_start: string; // HH:MM
  reminder_end: string; // HH:MM
  reminder_interval_hours: number;
  updated_at: string;
}

export interface WaterLog {
  id: number;
  amount_ml: number;
  date: string; // YYYY-MM-DD
  logged_at: string; // ISO timestamp
}

export interface WaterToday {
  total: number;
  goal: number;
  percent: number;
  logs: WaterLog[];
}

export interface WaterIntakeResponse {
  total_today: number;
  goal: number;
  percent: number;
  log: WaterLog;
}

export interface WaterHistoryDay {
  date: string;
  total: number;
  goal: number;
}

export type WaterProfileInput = Partial<
  Pick<
    WaterProfile,
    | 'weight_kg'
    | 'height_cm'
    | 'activity_level'
    | 'daily_goal_ml'
    | 'reminder_enabled'
    | 'reminder_start'
    | 'reminder_end'
    | 'reminder_interval_hours'
  >
>;
