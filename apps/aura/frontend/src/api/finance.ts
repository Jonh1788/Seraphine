import { request } from "./client";
import type {
  EntryStatus,
  EntryType,
  FinanceBalance,
  FinanceEntriesResponse,
  FinanceSummary,
  FinancialEntry,
} from "../types/api";

export type SummaryQuery = {
  month?: number;
  year?: number;
};

export type EntriesQuery = {
  month?: number;
  year?: number;
  category?: string;
  type?: EntryType;
  status?: EntryStatus;
  limit?: number;
};

export function getSummary(query: SummaryQuery = {}): Promise<FinanceSummary> {
  return request<FinanceSummary>("/finance/summary", { query: { ...query } });
}

export function getBalance(): Promise<FinanceBalance> {
  return request<FinanceBalance>("/finance/balance");
}

export async function listEntries(query: EntriesQuery = {}): Promise<FinancialEntry[]> {
  const res = await request<FinanceEntriesResponse>("/finance/entries", { query: { ...query } });
  return res.entries;
}

export interface CreateEntryBody {
  type: EntryType;
  amount: number;
  currency: string;
  category: string;
  description?: string;
  date: string;
  source?: string;
  status: EntryStatus;
}

export function createEntry(body: CreateEntryBody): Promise<{ id: string; ok: boolean }> {
  return request("/finance/entries", { method: "POST", body });
}
