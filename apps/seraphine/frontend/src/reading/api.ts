/** 091 -- Reading List API layer. */

import { API_BASE } from '../api';
import type { ReadingItem, ReadingStatus } from './types';

// ---------- Reading items ----------

export interface FetchItemsParams {
  status?: ReadingStatus;
  tag?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface FetchItemsResult {
  items: ReadingItem[];
  total: number;
  /** Global per-status counts (GROUP BY status), independent of the active
   *  filter, so the header subtitle reflects the whole library. */
  byStatus: Partial<Record<ReadingStatus, number>>;
}

export async function saveReadingItem(
  url: string,
  tags?: string[],
): Promise<ReadingItem> {
  const res = await fetch(`${API_BASE}/reading/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, tags }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: { item: ReadingItem } = await res.json();
  return data.item;
}

export async function fetchReadingItems(
  params: FetchItemsParams = {},
): Promise<FetchItemsResult> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.tag) qs.set('tag', params.tag);
  if (params.q) qs.set('q', params.q);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const res = await fetch(`${API_BASE}/reading/items?${qs.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: {
    items: ReadingItem[];
    total?: number;
    by_status?: Partial<Record<ReadingStatus, number>>;
  } = await res.json();
  return {
    items: data.items,
    total: data.total ?? data.items.length,
    byStatus: data.by_status ?? {},
  };
}

export async function fetchReadingItem(id: string): Promise<ReadingItem> {
  const res = await fetch(`${API_BASE}/reading/items/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: { item: ReadingItem } = await res.json();
  return data.item;
}

export async function updateReadingItem(
  id: string,
  body: { status?: ReadingStatus; tags?: string[]; progress?: number },
): Promise<ReadingItem> {
  const res = await fetch(`${API_BASE}/reading/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: { item: ReadingItem } = await res.json();
  return data.item;
}

export async function deleteReadingItem(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/reading/items/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function searchReading(
  q: string,
  limit = 10,
): Promise<ReadingItem[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(`${API_BASE}/reading/search?${qs.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: { items: ReadingItem[] } = await res.json();
  return data.items;
}

// ---------- Flashcard integration ----------

/** Generate a flashcard deck from a topic. The /flashcards/decks endpoint
 *  takes {topic, count} only (no article-content field), and rejects topics
 *  over 200 chars with 422, so trim before sending. Article-text-aware deck
 *  generation needs a backend `content` field -> deferred to Wave B. */
export async function createFlashcardDeck(topic: string): Promise<void> {
  const trimmed = topic.trim().slice(0, 200);
  const res = await fetch(`${API_BASE}/flashcards/decks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: trimmed }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
