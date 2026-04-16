/**
 * Types for the Notes module -- mirrors the backend contract in
 * apps/seraphine/backend/.../notes.
 */

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
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
