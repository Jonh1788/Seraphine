import { API_BASE } from '../api';
import type {
  FinanceBalance,
  FinanceEntry,
  FinanceEntryListResponse,
  FinanceSummary,
  ListEntriesParams,
} from './types';

/**
 * Data layer for the Finance module. No React, no formatting — every caller
 * (desktop dashboard and mobile screens) goes through here instead of
 * touching `fetch`/`API_BASE` directly.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * `GET /finance/entries`.
 *
 * `month` is **1-indexed** (1 = January), exactly as the backend expects
 * (`substr(date,1,7) = 'YYYY-MM'`). It is forwarded verbatim — a JS
 * `Date#getMonth()` caller must pass `month + 1` itself.
 */
export async function listEntries(params: ListEntriesParams): Promise<FinanceEntry[]> {
  const qs = new URLSearchParams();
  if (params.status !== undefined) qs.set('status', params.status);
  if (params.month !== undefined) qs.set('month', String(params.month));
  if (params.year !== undefined) qs.set('year', String(params.year));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const query = qs.toString();
  const data = await request<FinanceEntryListResponse>(
    `/finance/entries${query ? `?${query}` : ''}`,
  );
  return Array.isArray(data?.entries) ? data.entries : [];
}

/**
 * `GET /finance/summary?month=&year=`.
 *
 * `month` is **1-indexed** (1 = January) and forwarded verbatim: no +1, no
 * derivation here. Callers holding a zero-indexed JS month pass `month + 1`.
 */
export async function fetchSummary(month: number, year: number): Promise<FinanceSummary> {
  const qs = new URLSearchParams({ month: String(month), year: String(year) });
  return request<FinanceSummary>(`/finance/summary?${qs.toString()}`);
}

/** `GET /finance/balance` — overall confirmed balance across all months. */
export async function fetchBalance(): Promise<FinanceBalance> {
  return request<FinanceBalance>('/finance/balance');
}
