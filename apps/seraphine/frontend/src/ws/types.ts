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
  /** When true, the backend follows turn_end with TTS frames so the
   *  assistant reply is also spoken aloud (typed input + voice output). */
  speak?: boolean;
  /** Base64 data-URL images attached to this message (vision support). */
  images?: string[];
  /** Staged attachments (image/PDF) referenced by id; resolved server-side. */
  attachments?: { id: string; kind: string; mime: string; filename: string }[];
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

// 022-D — proactive opener emitted by the backend when the WS connects
// after a quiet period. The frontend inserts it as an assistant turn
// and plays TTS through the normal path.
export interface AssistantOpenerMessage {
  type: 'assistant_opener';
  text: string;
}

// 032-B — embodied reaction: backend detected a trigger phrase in the
// user's message and wants the avatar to do a quick animation.
export interface AvatarActionMessage {
  type: 'avatar_action';
  action:
    | 'breathe_with_user'
    | 'raise_hand'
    | 'high_five'
    | 'wave_goodbye'
    | 'stretch'
    | 'yawn_slow'
    | 'smile_encouraging'
    | 'hug_gesture';
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

// Phase 2 — STT transcription result
export interface TranscriptionMessage {
  type: 'transcription';
  conversation_id: string;
  text: string;
}

// Phase 4 — tool use with approval gate
export interface ToolRequestMessage {
  type: 'tool_request';
  request_id: string;
  tool: string;
  args: Record<string, unknown>;
  requires_confirmation: boolean;
}

export interface ToolResultMessage {
  type: 'tool_result';
  request_id: string;
  ok: boolean;
  output: string | null;
  error: string | null;
  /** Structured metadata from the tool. E.g. fetch_image puts
   *  {image_data_url, url, caption, content_type, bytes} here. */
  metadata?: Record<string, unknown>;
}

export interface ToolApprovalMessage {
  type: 'tool_approval';
  request_id: string;
  approved: boolean;
}

// MCP task notifications
export interface NotificationMessage {
  type: 'notification';
  source: string;
  event: string;
  task_id: string;
  title: string;
  status: string;
  summary: string;
  message: string;
}

export interface ReminderMessage {
  type: 'reminder';
  reminder_id: string;
  message: string;
  fired_at: string;
}

export interface McpApprovalRequestMessage {
  type: 'mcp_approval_request';
  task_id: string;
  title: string;
  body: string;
  plan: string;
  /** Optional: who the approval is delegated to (e.g. "user", agent name). */
  assignee?: string;
}

export interface McpApprovalResponseMessage {
  type: 'mcp_approval_response';
  task_id: string;
  approved: boolean;
  comment?: string;
}

export interface MoodMessage {
  type: 'mood';
  mood: string;
  intensity: number;
  duration_ms: number;
}

export interface WhatsAppNotificationMessage {
  type: 'whatsapp_notification';
  event: string;
  chatId: string;
  chatName: string;
  author: string;
  body: string;
  messageId: string;
  timestamp?: number;
  fromMe?: boolean;
  important?: boolean;
}

export type ClientMessage =
  | PingMessage
  | UserMessage
  | AudioStartMessage
  | AudioEndMessage
  | ToolApprovalMessage
  | McpApprovalResponseMessage
  | { type: string; [k: string]: unknown };
export type ServerMessage =
  | PongMessage
  | EchoMessage
  | ErrorMessage
  | TokenMessage
  | TurnEndMessage
  | AssistantOpenerMessage
  | AvatarActionMessage
  | TtsStartMessage
  | TtsEndMessage
  | TranscriptionMessage
  | ToolRequestMessage
  | ToolResultMessage
  | NotificationMessage
  | ReminderMessage
  | McpApprovalRequestMessage
  | MoodMessage
  | WhatsAppNotificationMessage;

