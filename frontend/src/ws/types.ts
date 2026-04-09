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

// Phase 2 — voice I/O
export interface AudioStartMessage {
  type: 'audio_start';
  conversation_id?: string;
  sample_rate: number;
}

export interface AudioEndMessage {
  type: 'audio_end';
  conversation_id?: string;
}

export interface TtsStartMessage {
  type: 'tts_start';
  turn_id: string;
  sample_rate: number;
}

export interface TtsEndMessage {
  type: 'tts_end';
  turn_id: string;
}

export type ClientMessage =
  | PingMessage
  | UserMessage
  | AudioStartMessage
  | AudioEndMessage
  | { type: string; [k: string]: unknown };
export type ServerMessage =
  | PongMessage
  | EchoMessage
  | ErrorMessage
  | TokenMessage
  | TurnEndMessage
  | TtsStartMessage
  | TtsEndMessage;
