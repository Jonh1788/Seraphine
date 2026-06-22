import { API_BASE } from '../api';

export type DeckSource = 'topic' | 'research' | 'note' | 'article' | 'chat';

export interface Card {
  id: string; topic: string; front: string; back: string;
  tags?: string[]; source_url?: string | null; source_title?: string | null;
  image_url?: string | null;
}

async function jsonOrThrow(res: Response): Promise<any> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b?.detail) detail = String(b.detail); } catch { /* */ }
    throw new Error(detail);
  }
  return res.json();
}

export interface CreateDeckBody {
  source: DeckSource; topic?: string; count?: number;
  note_id?: string; reading_item_id?: string; text?: string;
}

export async function createDeck(body: CreateDeckBody): Promise<{ cards: Card[]; topic: string; count: number }> {
  const res = await fetch(`${API_BASE}/flashcards/decks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

export async function createCard(body: { topic: string; front: string; back: string; tags?: string[]; source_url?: string }): Promise<{ card: Card }> {
  const res = await fetch(`${API_BASE}/flashcards/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

export async function editCard(id: string, patch: Partial<Card>): Promise<{ card: Card }> {
  const res = await fetch(`${API_BASE}/flashcards/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  return jsonOrThrow(res);
}

export async function generateCardImage(id: string): Promise<{ card: Card }> {
  const res = await fetch(`${API_BASE}/flashcards/${encodeURIComponent(id)}/image`, { method: 'POST' });
  return jsonOrThrow(res);
}

// --- Picker sources for the "Da minha nota" / "Do artigo" deck sources ---

export interface PickerOption {
  id: string;
  title: string;
}

/** Notes list (GET /notes -> {notes:[{id,title,...}]}). Coerced defensively
 *  in case the backend ever returns a bare array. Non-fatal: returns []. */
export async function listNotePickers(): Promise<PickerOption[]> {
  try {
    const res = await fetch(`${API_BASE}/notes`);
    if (!res.ok) return [];
    const data = await res.json();
    const rows: any[] = Array.isArray(data) ? data : (data?.notes ?? data?.items ?? []);
    return rows
      .filter((r) => r && r.id)
      .map((r) => ({ id: String(r.id), title: String(r.title ?? r.id) }));
  } catch {
    return [];
  }
}

/** Reading items (GET /reading/items -> {items:[{id,title,...}]}). Coerced
 *  defensively. Non-fatal: returns []. */
export async function listArticlePickers(): Promise<PickerOption[]> {
  try {
    const res = await fetch(`${API_BASE}/reading/items`);
    if (!res.ok) return [];
    const data = await res.json();
    const rows: any[] = Array.isArray(data) ? data : (data?.items ?? data?.notes ?? []);
    return rows
      .filter((r) => r && r.id)
      .map((r) => ({ id: String(r.id), title: String(r.title ?? r.url ?? r.id) }));
  } catch {
    return [];
  }
}
