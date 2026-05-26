/** 095 — Contextual shortcuts per active app: shared types. */

export interface ContextualAction {
  id: string;
  label: string;
  description: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
}
