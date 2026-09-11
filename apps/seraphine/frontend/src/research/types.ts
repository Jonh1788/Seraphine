/**
 * Types for the Deep Research ("Deepsearch") module -- mirrors the backend
 * contract in apps/seraphine/backend/seraphine/deepsearch.
 */

export type ResearchMode = 'quick' | 'deep';

export interface Source {
  url: string;
  title: string;
  n?: number;
}

export interface ResearchRun {
  id: string;
  query: string;
  mode: ResearchMode;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  report: string | null;
  sources: Source[];
  progress?: ResearchEvent[];
  fanout_model?: string;
  synth_model?: string;
  created_at: string;
  finished_at: string | null;
}

export type ResearchEvent =
  | {
      type: 'snapshot';
      status: ResearchRun['status'];
      report: string | null;
      sources: Source[];
      progress: ResearchEvent[];
    }
  | { type: 'plan'; sub_questions: string[]; criteria: string[] }
  | { type: 'round'; n: number; total: number }
  | { type: 'query'; q: string }
  | { type: 'source_found'; url: string; title: string }
  | { type: 'source_read'; url: string; ok: boolean }
  | { type: 'synthesis'; text: string }
  | { type: 'report'; markdown: string; sources: Source[] }
  | { type: 'error'; message: string }
  | { type: 'done'; status: string };

export interface ModelOption {
  id: string;
  name: string;
  /** O modelo aceita esforço de raciocínio (`reasoning` no catálogo)?
   *
   *  Vem do `supported_parameters` da OpenRouter — 212 dos 337 modelos em
   *  2026-08-02. Opcional porque a lista curada do cliproxy não tem o campo,
   *  e `undefined` é tratado como "não" em todo lugar. */
  reasoning?: boolean;
}

/** Esforços que a UI oferece.
 *
 *  A OpenRouter documenta ainda `minimal` e `xhigh`; o backend valida os seis
 *  (`normalize_effort`), então acrescentar aqui não pede mudança lá. `''` é
 *  desligado: não manda o parâmetro e o modelo fica no comportamento padrão
 *  dele — diferente de `none`, que DESLIGA o raciocínio de quem pensa sempre. */
export const EFFORTS = ['', 'low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABELS: Record<Effort, string> = {
  '': 'Desligado',
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  max: 'Máximo',
};

export interface DeepsearchConfig {
  fanout_model: string;
  synth_model: string;
  openrouter_key_set: boolean;
}
