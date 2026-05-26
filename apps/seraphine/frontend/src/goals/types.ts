/**
 * Types for the Goals module -- mirrors the backend contract.
 */

export type GoalArea =
  | 'saude'
  | 'carreira'
  | 'financas'
  | 'pessoal'
  | 'aprendizado'
  | 'relacionamentos';

export type GoalTimeframe = 'quarterly' | 'yearly' | 'open_ended';

export type GoalStatus = 'active' | 'paused' | 'completed' | 'abandoned';

export type KRMetricType = 'numeric' | 'boolean' | 'percentage';

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  area: GoalArea;
  timeframe: GoalTimeframe;
  start_date: string | null;
  end_date: string | null;
  status: GoalStatus;
  progress: number; // 0-100, computed by backend
  created_at: string;
  updated_at: string;
}

export interface KeyResult {
  id: string;
  goal_id: string;
  title: string;
  metric_type: KRMetricType;
  target_value: number;
  current_value: number;
  unit: string | null;
  auto_source: string | null;
  progress: number; // 0-100
}

export interface GoalLink {
  id: string;
  goal_id: string;
  linked_type: string;
  linked_id: string;
}

export interface GoalSummary {
  goals_at_risk: number;
  goals_on_track: number;
  goals_completed: number;
  total_active: number;
}

export interface GoalDetailResponse {
  goal: Goal;
  key_results: KeyResult[];
  links: GoalLink[];
}

export interface GoalListResponse {
  goals: Goal[];
}

export interface GoalCreateInput {
  title: string;
  description?: string | null;
  area: GoalArea;
  timeframe: GoalTimeframe;
  start_date?: string | null;
  end_date?: string | null;
}

export interface GoalUpdateInput {
  title?: string;
  description?: string | null;
  area?: GoalArea;
  timeframe?: GoalTimeframe;
  start_date?: string | null;
  end_date?: string | null;
  status?: GoalStatus;
}

export interface KRCreateInput {
  title: string;
  metric_type: KRMetricType;
  target_value: number;
  unit?: string | null;
  auto_source?: string | null;
}

export interface KRUpdateInput {
  current_value?: number;
  target_value?: number;
}

/* Display name maps */

export const AREA_LABELS: Record<GoalArea, string> = {
  saude: 'Saude',
  carreira: 'Carreira',
  financas: 'Financas',
  pessoal: 'Pessoal',
  aprendizado: 'Aprendizado',
  relacionamentos: 'Relacionamentos',
};

export const TIMEFRAME_LABELS: Record<GoalTimeframe, string> = {
  quarterly: 'Trimestral',
  yearly: 'Anual',
  open_ended: 'Sem prazo',
};

export const STATUS_LABELS: Record<GoalStatus, string> = {
  active: 'Ativo',
  paused: 'Pausado',
  completed: 'Concluido',
  abandoned: 'Abandonado',
};

export const AREA_COLORS: Record<GoalArea, string> = {
  saude: '#10b981',
  carreira: '#3b82f6',
  financas: '#f59e0b',
  pessoal: '#a78bfa',
  aprendizado: '#06b6d4',
  relacionamentos: '#ec4899',
};

export const ALL_AREAS: GoalArea[] = [
  'saude',
  'carreira',
  'financas',
  'pessoal',
  'aprendizado',
  'relacionamentos',
];

export const ALL_STATUSES: GoalStatus[] = ['active', 'paused', 'completed', 'abandoned'];
