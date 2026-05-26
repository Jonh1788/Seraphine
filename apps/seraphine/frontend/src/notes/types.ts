/**
 * Types for the Notes module -- mirrors the backend contract in
 * apps/seraphine/backend/.../notes.
 */

export interface NoteRef {
  id: string;
  title: string;
}

export interface TaskSummary {
  id: number;
  title: string;
  status: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  backlinks: NoteRef[];
  linked_tasks: TaskSummary[];
}

export interface NoteCreateInput {
  title: string;
  content?: string;
  tags?: string[];
}

export type NoteUpdateInput = Partial<NoteCreateInput>;

export interface NoteListResponse {
  notes: Note[];
}

export interface NoteResponse {
  note: Note;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface TagsResponse {
  tags: TagCount[];
}
