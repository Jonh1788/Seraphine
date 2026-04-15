import { request } from "./client";
import type { InlineRecurring } from "./chat";

export type { InlineRecurring };

export async function listRecurring(): Promise<InlineRecurring[]> {
  const res = await request<{ recurring?: InlineRecurring[] } | null>("/recurring");
  // Backend returns {recurring: [...]} but be defensive against shape
  // drift (e.g., a 204 or empty body returning null).
  return Array.isArray(res?.recurring) ? res!.recurring : [];
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
  }>,
): Promise<{ recurring: InlineRecurring }> {
  return request(`/recurring/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}
