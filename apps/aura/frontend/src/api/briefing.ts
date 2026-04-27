import { request } from "./client";

export type SegmentKind = "text" | "urgent" | "good" | "blue";

export interface BriefingSegment {
  kind: SegmentKind;
  text: string;
}

export interface Briefing {
  text: string;
  segments: BriefingSegment[];
  generated_at: string;
  ttl_seconds: number;
}

export function getTodayBriefing(): Promise<Briefing> {
  return request<Briefing>("/briefing/today");
}

export function refreshBriefing(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/briefing/refresh", { method: "POST" });
}
