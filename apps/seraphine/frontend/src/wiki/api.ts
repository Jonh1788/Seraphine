import { API_BASE } from '../api';
import type { WikiGraph, WikiIndexItem, WikiPage } from './types';

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

export function listWikiIndex(): Promise<WikiIndexItem[]> {
  return request<WikiIndexItem[]>('/wiki/index');
}

export function getWikiPage(slug: string): Promise<WikiPage> {
  return request<WikiPage>(`/wiki/page/${encodeURIComponent(slug)}`);
}

export function getWikiGraph(): Promise<WikiGraph> {
  return request<WikiGraph>('/wiki/graph');
}

export function getWikiSource(ref: string): Promise<{ ref: string; content: string }> {
  return request<{ ref: string; content: string }>(`/wiki/source/${ref}`);
}
