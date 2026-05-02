import { request } from "./client";

export interface WhatsAppStatus {
  /** True iff this user has a verified WhatsApp number bound. */
  verified: boolean;
  /** Display-safe phone, e.g. "+55 11 9••••-••42"; null when not bound. */
  phone_masked: string | null;
}

/** Read the current user's WhatsApp connection status. */
export function getStatus(): Promise<WhatsAppStatus> {
  return request<WhatsAppStatus>("/whatsapp/status");
}

/** Kick off the verification dance: backend generates + SMS-sends a
 *  6-digit code to ``phone`` (E.164). Resolves once the code has been
 *  dispatched (not when the user enters it). */
export function startConnect(phone: string): Promise<{ ok: true }> {
  return request<{ ok: true }>("/whatsapp/connect/start", {
    method: "POST",
    body: { phone },
  });
}

/** Confirm a previously-issued code. Backend persists the binding on
 *  success; throws ApiError(400) on wrong/expired/exhausted codes. */
export function verifyCode(code: string): Promise<{ ok: true }> {
  return request<{ ok: true }>("/whatsapp/connect/verify", {
    method: "POST",
    body: { code },
  });
}

/** Drop the verified binding for the current user. */
export function disconnect(): Promise<{ ok: true }> {
  return request<{ ok: true }>("/whatsapp/disconnect", { method: "POST" });
}
