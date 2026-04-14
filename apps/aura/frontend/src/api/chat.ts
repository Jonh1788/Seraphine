import { request } from "./client";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReply {
  reply: string;
}

export function sendMessage(messages: ChatMessage[]): Promise<ChatReply> {
  return request<ChatReply>("/chat/messages", {
    method: "POST",
    body: { messages },
  });
}
