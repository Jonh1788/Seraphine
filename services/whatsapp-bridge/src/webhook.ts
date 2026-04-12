export interface WebhookPayload {
  event: "message";
  chatId: string;
  chatName: string;
  message: {
    id: string;
    body: string;
    timestamp: number;
    fromMe: boolean;
    author: string;
    type: string;
  };
}

export async function dispatchWebhook(
  url: string,
  payload: WebhookPayload
): Promise<void> {
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(
        `[whatsapp-bridge] webhook POST ${url} returned ${res.status}`
      );
    }
  } catch (err) {
    console.warn(
      `[whatsapp-bridge] webhook POST ${url} failed:`,
      (err as Error).message
    );
  }
}
