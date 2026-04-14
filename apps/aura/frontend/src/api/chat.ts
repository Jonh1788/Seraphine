import { request, getToken, ApiError } from "./client";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReply {
  reply: string;
}

/** Non-streaming variant — kept for tests / scripting. */
export function sendMessage(messages: ChatMessage[]): Promise<ChatReply> {
  return request<ChatReply>("/chat/messages/sync", {
    method: "POST",
    body: { messages },
  });
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
  signal?: AbortSignal;
}

/** Stream the reply token-by-token. Calls ``onDelta`` for each text
 *  chunk, then either ``onDone`` (success) or ``onError`` (failure). */
export async function streamMessage(
  messages: ChatMessage[],
  handlers: StreamHandlers,
): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch("/chat/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ messages }),
    signal: handlers.signal,
  });

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

      // SSE events are separated by a blank line. A single event may
      // span multiple lines starting with "data:" — concatenate them
      // and JSON.parse the payload.
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
            done?: boolean;
            error?: string;
          };
          if (typeof parsed.delta === "string") handlers.onDelta(parsed.delta);
          if (parsed.error) {
            handlers.onError(parsed.error);
            return;
          }
          if (parsed.done) {
            handlers.onDone();
            return;
          }
        } catch {
          // Ignore malformed event — keep streaming.
        }
      }
    }
    // Stream ended without a `done` event (uncommon — backend always
    // sends one). Treat as success anyway.
    handlers.onDone();
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return;
    handlers.onError(err instanceof Error ? err.message : String(err));
  }
}
