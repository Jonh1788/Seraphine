import { request } from "./client";

export interface Notebook {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
  note_count: number;
}

export interface Note {
  id: string;
  notebook_id: string;
  user_id: string;
  title: string | null;
  content_md: string;
  created_at: string;
  updated_at: string;
}

export function listNotebooks(): Promise<{ notebooks: Notebook[] }> {
  return request("/knowledge/notebooks");
}

export function createNotebook(body: { name: string; color?: string }): Promise<Notebook> {
  return request<Notebook>("/knowledge/notebooks", { method: "POST", body });
}

export function renameNotebook(id: string, name: string): Promise<Notebook> {
  return request<Notebook>(`/knowledge/notebooks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { name },
  });
}

export function deleteNotebook(id: string): Promise<{ ok: boolean }> {
  return request(`/knowledge/notebooks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listNotes(notebookId: string): Promise<{ notes: Note[] }> {
  return request(`/knowledge/notebooks/${encodeURIComponent(notebookId)}/notes`);
}

export function getNote(id: string): Promise<Note> {
  return request<Note>(`/knowledge/notes/${encodeURIComponent(id)}`);
}

export function createNote(body: {
  notebook_id: string;
  title?: string | null;
  content_md?: string;
}): Promise<Note> {
  return request<Note>("/knowledge/notes", { method: "POST", body });
}

export function updateNote(
  id: string,
  body: { title?: string | null; content_md?: string },
): Promise<Note> {
  return request<Note>(`/knowledge/notes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteNote(id: string): Promise<{ ok: boolean }> {
  return request(`/knowledge/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function searchNotes(q: string): Promise<{ notes: Note[] }> {
  return request("/knowledge/search", { query: { q } });
}
