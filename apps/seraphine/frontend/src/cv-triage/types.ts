export type JobStatus =
  | "queued" | "extracting" | "ranking" | "sending" | "done" | "failed" | "cancelled";
export type WhatsAppStatus = "pending" | "text_sent" | "all_sent" | "failed";
export type TextSource = "pdfplumber" | "tesseract" | "vision" | "none";
export type ResultStatus = "pending" | "extracted" | "ranked" | "failed";

export interface JobSummary {
  id: number;
  status: JobStatus;
  total_cvs: number;
  processed_cvs: number;
  ocr_used_count: number;
  vision_used_count: number;
  unreadable: number;
  target_label: string;
  target_chat_id: string;
  rubric: string;
  whatsapp_status: WhatsAppStatus | null;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  top5: Top5Entry[] | null;
}

export interface Top5Entry {
  rank: number;
  filename: string;
  candidate_name: string | null;
  score: number;
  match_pct: number;
  strengths: string[];
  gaps: string[];
  justification: string;
}

export interface JobDetail extends JobSummary {
  results: ResultRow[];
}

export interface ResultRow {
  filename: string;
  candidate_name: string | null;
  text_source: TextSource;
  text_chars: number;
  score: number | null;
  match_pct: number | null;
  strengths: string[];
  gaps: string[];
  justification: string | null;
  status: ResultStatus;
  error: string | null;
  ranked_at: string | null;
}

export interface Chat {
  id: string;           // ends with @g.us (group) or @c.us (1:1)
  name: string;
  isGroup: boolean;
}

// WebSocket frames emitted by the backend during a triage run.
export interface ProgressFrame {
  type: "cv_triage_progress";
  job_id: number;
  phase: "extracting" | "ranking" | "sending";
  processed: number;
  total: number;
  current_filename?: string;
  ocr_used_count: number;
  vision_used_count: number;
}

export interface FinishedFrame {
  type: "cv_triage_finished";
  job_id: number;
  top5: Top5Entry[];
  whatsapp_status: WhatsAppStatus;
  unreadable: number;
}
