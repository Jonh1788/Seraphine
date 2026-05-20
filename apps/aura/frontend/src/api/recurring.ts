import { request } from "./client";
import type { InlineRecurring } from "./chat";

export type { InlineRecurring };

export interface CreateRecurringBody {
  title: string;
  frequency: "daily" | "weekly" | "monthly";
  weekday?: number | null;
  day_of_month?: number | null;
  time?: string | null;
  description?: string | null;
  // Omit to inherit per-user defaults; [] for "no extras"; list for explicit.
  reminder_offsets?: number[] | null;
}

export async function listRecurring(): Promise<InlineRecurring[]> {
  const res = await request<{ recurring?: InlineRecurring[] } | null>("/recurring");
  // Backend returns {recurring: [...]} but be defensive against shape
  // drift (e.g., a 204 or empty body returning null).
  return Array.isArray(res?.recurring) ? res!.recurring : [];
}

export function createRecurring(
  body: CreateRecurringBody,
): Promise<{ id: string; recurring: InlineRecurring }> {
  return request("/recurring", { method: "POST", body });
}

export function deleteRecurring(id: string): Promise<{ ok: boolean }> {
  return request(`/recurring/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function updateRecurring(
  id: string,
  body: Partial<{
    active: boolean;
    time: string | null;
    weekday: number | null;
    day_of_month: number | null;
    title: string;
    description: string;
    reminder_offsets: number[] | null;
  }>,
): Promise<{ recurring: InlineRecurring }> {
  return request(`/recurring/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}
