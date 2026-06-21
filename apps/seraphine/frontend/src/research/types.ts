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
}

export interface DeepsearchConfig {
  fanout_model: string;
  synth_model: string;
  openrouter_key_set: boolean;
}
