import { request, getToken, ApiError } from "./client";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_snippet: string | null;
}

export interface ConversationDetail {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  messages: { id: string; role: "user" | "assistant"; content: string; created_at: string }[];
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listConversations(limit = 50): Promise<ConversationSummary[]> {
  const res = await request<{ conversations: ConversationSummary[] }>(
    "/chat/conversations",
    { query: { limit } },
  );
  return res.conversations;
}

export async function createConversation(title?: string | null): Promise<string> {
  const res = await request<{ id: string; ok: boolean }>(
    "/chat/conversations",
    { method: "POST", body: { title: title ?? null } },
  );
  return res.id;
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return request<ConversationDetail>(`/chat/conversations/${encodeURIComponent(id)}`);
}

export function deleteConversation(id: string): Promise<{ ok: boolean }> {
  return request(`/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Streaming send (per-conversation)
// ---------------------------------------------------------------------------

export interface InlineTransaction {
  id: number;
  type: "income" | "expense";
  amount: number;
  currency: string;
  category: string;
  description: string;
  date: string;
  status: string;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onTransaction?: (entry: InlineTransaction) => void;
  onDone: (info: { title?: string }) => void;
  onError: (msg: string) => void;
  signal?: AbortSignal;
}

export async function streamMessage(
  conversationId: string,
  content: string,
  handlers: StreamHandlers,
): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ content }),
      signal: handlers.signal,
    },
  );

  if (!res.ok) {
    let msg = res.statusText || "Falha ao iniciar stream";
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data.detail === "string") msg = data.detail;
    } catch {
      /* not JSON */
    }
    handlers.onError(msg);
    throw new ApiError(res.status, msg, null);
  }
  if (!res.body) {
    handlers.onError("Stream vazio");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (!dataLines.length) continue;
        const payload = dataLines.join("\n");
        try {
          const parsed = JSON.parse(payload) as {
            delta?: string;
            transaction?: InlineTransaction;
            done?: boolean;
            title?: string;
            error?: string;
          };
          if (typeof parsed.delta === "string") handlers.onDelta(parsed.delta);
          if (parsed.transaction && handlers.onTransaction) {
            handlers.onTransaction(parsed.transaction);
          }
          if (parsed.error) {
            handlers.onError(parsed.error);
            return;
          }
          if (parsed.done) {
            handlers.onDone({ title: parsed.title });
            return;
          }
        } catch {
          /* ignore malformed event */
        }
      }
    }
    handlers.onDone({});
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return;
    handlers.onError(err instanceof Error ? err.message : String(err));
  }
}
