/**
 * Types for the Journal module -- mirrors the backend contract.
 */

export type JournalType = 'day_review' | 'weekly_reflection' | 'manual' | 'voice_memo';

export type JournalSource = 'proactive' | 'user' | 'voice';

export interface JournalEntry {
  id: string;
  date: string;
  type: JournalType;
  title: string;
  content: string;
  mood_label: string | null;
  mood_valence: number | null;
  tags: string[];
  source: JournalSource;
  source_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface JournalListResponse {
  entries: JournalEntry[];
  total: number;
}

export interface JournalSearchResponse {
  results: JournalEntry[];
}

export interface JournalCreateInput {
  title: string;
  content: string;
  tags?: string[];
}

export interface JournalUpdateInput {
  title?: string;
  content?: string;
  tags?: string[];
}
