export interface TimeBlock {
  id: string;
  start: string; // HH:MM
  end: string;   // HH:MM
  type: 'focus' | 'meeting' | 'break' | 'exercise' | 'admin' | 'free';
  title: string;
  linked_id?: string | null;
  reason?: string | null;
}

export interface PlanContext {
  sleep_hours: number | null;
  energy_estimate: 'high' | 'medium' | 'low';
  meetings_count: number;
  free_slots_min: number;
  mood_valence: number | null;
  mood_reason: string | null;
  /** Model-written plan pitch. Null when the LLM was unavailable. */
  summary?: string | null;
  /** True only when the summary/reasons came from a real LLM pass. */
  ai_generated?: boolean;
}

export interface DailyPlan {
  time_blocks: TimeBlock[];
  priorities: Array<{
    id: string;
    title: string;
    due_date?: string;
    priority?: string | null;
  }>;
  at_risk: {
    habits: Array<{
      id: string;
      title: string;
      current_streak: number;
    }>;
    goals: Array<{
      id: string;
      title: string;
      progress: number;
    }>;
  };
  context: PlanContext;
}

export interface PlanHistoryEntry {
  date: string;
  accepted: boolean;
  blocks_count: number;
  priorities_count: number;
  created_at: string;
  feedback: {
    date: string;
    blocks_planned: number;
    blocks_executed: number;
    tasks_planned: number;
    tasks_done: number;
  } | null;
}
