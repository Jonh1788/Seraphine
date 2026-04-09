// Mirrors backend message envelopes from specs/schemas/ws-messages.schema.json.
// Keep narrow for Phase 0 — extend in later phases.

export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
  ts: string;
}

export interface EchoMessage {
  type: 'echo';
  data: Record<string, unknown>;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type ClientMessage = PingMessage | { type: string; [k: string]: unknown };
export type ServerMessage = PongMessage | EchoMessage | ErrorMessage;
