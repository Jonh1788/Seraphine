/** 091 -- Reading List types. */

export interface ReadingItem {
  id: string;
  url: string;
  title: string;
  domain: string;
  summary: string;
  content_text: string;
  tags: string[];
  status: ReadingStatus;
  saved_at: string;
  read_at: string | null;
  archived_at: string | null;
  error_msg: string | null;
  // Real backend columns (Wave B): author parsed from page metadata, progress
  // is percent read (0-100). Both always present from the API now.
  author: string;
  progress: number;
  // Obsidian cover-card meta still derived client-side:
  //  - kind: heuristic by domain (no backend column; see deriveKind).
  //  - duration_min: estimated from content_text word count (no stored value).
  kind?: ReadingKind;
  duration_min?: number;
}

export type ReadingKind = 'livro' | 'artigo';

export type ReadingStatus =
  | 'processing'
  | 'unread'
  | 'reading'
  | 'read'
  | 'archived'
  | 'error';

export const STATUS_LABELS: Record<ReadingStatus, string> = {
  processing: 'Processando',
  unread: 'Quero ler',
  reading: 'Lendo',
  read: 'Lido',
  archived: 'Arquivado',
  error: 'Erro',
};
