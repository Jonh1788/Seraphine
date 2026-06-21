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
  /** Short PT-BR Seraphine reflection on the entry; null when none was generated. */
  reflection: string | null;
}

export interface JournalListResponse {
  entries: JournalEntry[];
  total: number;
}

/** GET /journal/:id, POST /journal, PATCH /journal/:id all wrap as { entry }. */
export interface JournalEntryEnvelope {
  entry: JournalEntry;
}

export interface JournalSearchResponse {
  results: JournalEntry[];
}

/** GET /journal/stats -- aggregate over the existing `date` column. */
export interface JournalStats {
  current_streak: number;
  longest_streak: number;
  total_entries: number;
  days_logged: number;
}

export interface JournalCreateInput {
  title: string;
  content: string;
  tags?: string[];
  /** Composer-selected mood. When set, wins over the conversation mood snapshot. */
  mood_label?: string | null;
  mood_valence?: number | null;
}

export interface JournalUpdateInput {
  title?: string;
  content?: string;
  tags?: string[];
}
