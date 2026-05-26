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
  return res.json();
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
  return res.json();
}

export async function fetchReadingItem(id: string): Promise<ReadingItem> {
  const res = await fetch(`${API_BASE}/reading/items/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function updateReadingItem(
  id: string,
  body: { status?: ReadingStatus; tags?: string[] },
): Promise<ReadingItem> {
  const res = await fetch(`${API_BASE}/reading/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  const data: { results: ReadingItem[] } = await res.json();
  return data.results;
}

// ---------- Flashcard integration ----------

export async function createFlashcardDeck(
  topic: string,
  content?: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/flashcards/decks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, content }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
