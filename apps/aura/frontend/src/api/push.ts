import { request } from "./client";

export function getVapidPublicKey(): Promise<{ key: string }> {
  return request<{ key: string }>("/push/vapid-public-key", { auth: false });
}

export interface SubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user_agent?: string;
}

export function subscribePush(body: SubscribeBody): Promise<{ id: string; ok: boolean }> {
  return request("/push/subscribe", { method: "POST", body });
}

export function unsubscribePush(endpoint: string): Promise<{ removed: number }> {
  return request("/push/unsubscribe", { method: "POST", body: { endpoint } });
}

export function sendTestPush(): Promise<{ sent: number }> {
  return request<{ sent: number }>("/push/test", { method: "POST" });
}
