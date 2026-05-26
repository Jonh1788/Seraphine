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
}

export type ReadingStatus =
  | 'processing'
  | 'unread'
  | 'reading'
  | 'read'
  | 'archived'
  | 'error';

export const STATUS_LABELS: Record<ReadingStatus, string> = {
  processing: 'Processando',
  unread: 'Nao lido',
  reading: 'Lendo',
  read: 'Lido',
  archived: 'Arquivado',
  error: 'Erro',
};
