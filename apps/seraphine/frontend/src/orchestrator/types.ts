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
