export type PermissionMode = 'ask_all' | 'auto_reads' | 'full_auto';
export interface SessionInfo { session_id: string; slug: string; cwd: string; last_modified_ms: number; }
export type AgentEventKind =
  | { kind: 'init'; session_id?: string }
  | { kind: 'assistant' }
  | { kind: 'result' }
  | { kind: 'permission_request'; request_id: string; tool: string }
  | { kind: 'other' };
export interface AgentEvent { agent_id: string; kind: AgentEventKind; raw: unknown; }
