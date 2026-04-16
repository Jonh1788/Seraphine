/**
 * Types for the Apple Health integration (SDD 018).
 *
 * Mirrors both the Tauri Rust command shapes (see src-tauri/src/health.rs)
 * and the backend persistence schema (seraphine/health/models.py). Both
 * sides share the same field names so the frontend can pass bridge
 * output straight through to the sync endpoint.
 */

export type HealthMetric =
  | 'steps'
  | 'active_calories'
  | 'sleep'
  | 'weight'
  | 'heart_rate';

export interface WorkoutSample {
  type: string;
  start: string;
  end: string;
  duration_min: number;
  calories?: number | null;
  distance_km?: number | null;
}

export interface HealthSnapshot {
  date: string;
  steps: number;
  active_calories: number;
  resting_heart_rate?: number | null;
  sleep_minutes?: number | null;
  sleep_quality?: string | null;
  weight_kg?: number | null;
  workouts: WorkoutSample[];
  synced_at?: string;
}

export interface AuthorizationStatus {
  authorized: boolean;
  /** 'mock' | 'real' | 'unavailable' */
  mode: string;
  message: string;
}

export interface HealthTrendPoint {
  date: string;
  value: number;
}

export interface HealthTrendResponse {
  metric: HealthMetric;
  days: number;
  points: HealthTrendPoint[];
}

export interface HealthWeeklyReport {
  days: number;
  steps_avg: number;
  steps_total: number;
  active_calories_avg: number;
  workouts_total: number;
  workout_minutes_total: number;
  sleep_avg_minutes: number | null;
  resting_heart_rate_avg: number | null;
  weight_latest: number | null;
  snapshots: HealthSnapshot[];
}
