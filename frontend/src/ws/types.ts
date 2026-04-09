// Mirrors backend message envelopes from specs/schemas/ws-messages.schema.json.

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

// Phase 1 — conversation loop
export interface UserMessage {
  type: 'user_message';
  conversation_id?: string;
  content: string;
}

export interface TokenMessage {
  type: 'token';
  conversation_id: string;
  turn_id: string;
  text: string;
}

export interface TurnEndMessage {
  type: 'turn_end';
  conversation_id: string;
  turn_id: string;
}

export type ClientMessage = PingMessage | UserMessage | { type: string; [k: string]: unknown };
export type ServerMessage =
  | PongMessage
  | EchoMessage
  | ErrorMessage
  | TokenMessage
  | TurnEndMessage;
