export type PermissionMode = 'ask_all' | 'auto_reads' | 'full_auto';
export interface HostStatus { reachable: boolean; claude_version: string | null; error: string | null; }
export interface SessionInfo { session_id: string; slug: string; host?: string | null; cwd: string; last_modified_ms: number; }
export type AgentEventKind =
  | { kind: 'init'; session_id?: string }
  | { kind: 'assistant' }
  | { kind: 'result' }
  | { kind: 'permission_request'; request_id: string; tool: string }
  | { kind: 'other' };
export interface AgentEvent { agent_id: string; kind: AgentEventKind; raw: unknown; }
export interface SiSession { id: string; path: string; branch: string; }
export interface DiffFile { path: string; changes: string; }
export interface GateStep { cmd: string; ok: boolean; tail: string; timed_out: boolean; }
export interface GateResult { ok: boolean; steps: GateStep[]; }

/**
 * A pending permission request surfaced by the global Claude Code hook
 * (Maestro permission interception). The Rust event payload is snake_case
 * (`session_id`/`tool_name`/`tool_input`); the listener in `api.ts` maps it to
 * this camelCase shape so the rest of the app never sees snake_case.
 */
export interface PendingPermission {
  id: string;
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: string;
}

/** A distilled, reviewable skill awaiting publish (skills self-authoring v1). */
export interface SkillDraft {
  id: string;
  name: string;
  slug: string;
  skillMd: string;
  confidence: number;
  sourceAgentId: string;
  createdAt: number; // epoch ms
  status: 'draft' | 'published' | 'discarded';
  publishedPath?: string;
}
