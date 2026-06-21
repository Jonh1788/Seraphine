/**
 * Types for the Smart Insights module — mirrors the backend contract in
 * apps/seraphine/backend/seraphine/insights (SDD 015).
 */

export type InsightType = 'finance' | 'tasks' | 'habits' | 'productivity';

export type InsightSeverity = 'info' | 'warning' | 'positive';

export interface Insight {
  id: string;
  type: InsightType;
  severity: InsightSeverity;
  title: string;
  description: string;
  data: Record<string, unknown>;
  created_at: string;
  dismissed: boolean;
}

export interface InsightsListResponse {
  insights: Insight[];
}

export interface InsightDismissResponse {
  ok: true;
}

// Mirrors ``WeeklyReport.to_dict()`` in
// ``apps/seraphine/backend/seraphine/insights/models.py``.

export interface WeeklyReportTasks {
  created: number;
  completed: number;
  overdue: number;
}

export interface WeeklyReportFinance {
  income: number;
  expenses: number;
  balance: number;
}

export interface WeeklyReportHabitMaintained {
  title: string;
  streak: number;
}

export interface WeeklyReportHabitBroken {
  title: string;
  best_streak: number;
}

export interface WeeklyReportHabits {
  maintained: WeeklyReportHabitMaintained[];
  broken: WeeklyReportHabitBroken[];
}

// Mood / focus / goals / journal blocks are produced by the backend weekly
// report builders (insights/weekly.py) but were missing from this interface,
// so the real data was being dropped. They are optional because each block
// returns ``{}`` when there is no underlying data for the week.

export interface WeeklyReportMoodDailyAvg {
  date: string;
  avg_valence: number;
}

export interface WeeklyReportMood {
  summary?: string;
  trend?: 'subindo' | 'caindo' | 'estavel';
  daily_avgs?: WeeklyReportMoodDailyAvg[];
  best_day?: string | null;
  best_valence?: number | null;
  worst_day?: string | null;
  worst_valence?: number | null;
  total_logs?: number;
}

export interface WeeklyReportFocus {
  summary?: string;
  total_hours?: number;
  total_sessions?: number;
  completed_sessions?: number;
  completion_rate?: number;
  streak_days?: number;
  days_with_focus?: number;
}

export interface WeeklyReport {
  id: number | null;
  week_start: string;
  week_end: string;
  tasks: WeeklyReportTasks;
  finance: WeeklyReportFinance;
  habits: WeeklyReportHabits;
  goals: Record<string, unknown>;
  mood: WeeklyReportMood;
  focus: WeeklyReportFocus;
  journal: Record<string, unknown>;
  insights: Insight[];
  suggestion: string;
  created_at: string;
}

export interface WeeklyReportEnvelope {
  report: WeeklyReport | null;
}

// Mirrors ``FocusStats.to_dict()`` in
// ``apps/seraphine/backend/seraphine/focus/types.py``.

export interface FocusDayStat {
  date: string;
  focus_min: number;
  completed: number;
  cancelled: number;
  interruptions: number;
}

export interface FocusCategoryStat {
  category: string;
  focus_min: number;
  sessions: number;
}

export interface FocusStats {
  total_focus_min: number;
  completed_sessions: number;
  cancelled_sessions: number;
  avg_session_min: number;
  streak_days: number;
  interruption_rate: number;
  by_day: FocusDayStat[];
  by_category: FocusCategoryStat[];
}

// Mirrors the GET /insights/time-by-category envelope (insights/routes.py).
// Backs the "Onde foi seu tempo" card: focus minutes summed per category.

export interface TimeByCategoryEntry {
  category: string;
  focus_min: number;
  sessions: number;
  pct: number;
}

export interface TimeByCategoryResponse {
  period: 'week' | 'month';
  total_focus_min: number;
  categories: TimeByCategoryEntry[];
}
