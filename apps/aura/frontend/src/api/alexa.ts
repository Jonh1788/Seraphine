import { request } from "./client";

export interface AlexaStatus {
  /** True iff this user has an Amazon account linked to the Aura skill. */
  linked: boolean;
  /** Display-safe identifier (e.g. "…aB42") derived from the linked
   *  amazon_user_id. Null when not linked. The backend deliberately does
   *  not store the Amazon email, so this is an identifier suffix, not an
   *  email. */
  amazon_email_masked: string | null;
}

/** Read the current user's Alexa Account Linking status. */
export function getStatus(): Promise<AlexaStatus> {
  return request<AlexaStatus>("/alexa/status");
}

/** Drop the link for the current user: removes the row in
 *  aura_user_alexa and revokes every outstanding access/refresh token.
 *  Next Echo invocation will re-prompt with the LinkAccount card. */
export function disconnect(): Promise<{ ok: true }> {
  return request<{ ok: true }>("/alexa/disconnect", { method: "POST" });
}
