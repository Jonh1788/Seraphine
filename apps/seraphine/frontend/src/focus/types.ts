export interface FocusSession {
  id?: number;
  started_at: string;   // ISO 8601
  ended_at: string;     // ISO 8601
  type: 'work' | 'short_break' | 'long_break';
  completed: boolean;
  interruptions: number;
  notes?: string;
}

export interface FocusDayStat {
  date: string;         // YYYY-MM-DD
  focus_min: number;
  completed: number;
  cancelled: number;
  interruptions: number;
}

export interface FocusStats {
  total_focus_min: number;
  completed_sessions: number;
  cancelled_sessions: number;
  avg_session_min: number;
  streak_days: number;
  interruption_rate: number;
  by_day: FocusDayStat[];
}

export interface FocusAppEntry {
  app_name: string;
  total_sec: number;
}
