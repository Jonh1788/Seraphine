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

export interface WeeklyReport {
  id: number | null;
  week_start: string;
  week_end: string;
  tasks: WeeklyReportTasks;
  finance: WeeklyReportFinance;
  habits: WeeklyReportHabits;
  insights: Insight[];
  suggestion: string;
  created_at: string;
}

export interface WeeklyReportEnvelope {
  report: WeeklyReport | null;
}
